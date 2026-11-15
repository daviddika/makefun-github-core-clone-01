// graphql.ts — GitHub GraphQL v4 layer for the forge (Node 22 stdlib only; no deps).
//
// A small recursive-descent parser builds an AST for the documents the suite
// sends (operations, variables, arguments, aliases, inline fragments, __type
// introspection); the AST is then resolved against the shared store. No query
// text is regex-matched or eval'd for answers.
//
// Deterministic: no Date.now() / Math.random(); cursors encode a plain index.

import { parseGlobalId, repoGlobalId, issueGlobalId, pullGlobalId, commentGlobalId } from './store.ts';
import type { Repo, Issue, Pull, IssueComment, FileChange, Store } from './store.ts';
import { sendJson, parseJsonBody } from './http.ts';
import type { Ctx } from './http.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind: TokenKind, value: string, l: number, c: number): void => {
    tokens.push({ kind, value, line: l, column: c });
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      column += 1;
      continue;
    }
    if (ch === '\n') {
      i += 1;
      line += 1;
      column = 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
        column += 1;
      }
      continue;
    }
    if (ch === '"') {
      const startLine = line;
      const startCol = column;
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error(`Unterminated block string at ${startLine}:${startCol}`);
        let raw = source.slice(i + 3, end);
        if (raw.startsWith('\n')) raw = raw.slice(1);
        for (const c of raw) {
          if (c === '\n') {
            line += 1;
            column = 1;
          } else {
            column += 1;
          }
        }
        i = end + 3;
        column += 3;
        push('string', raw, startLine, startCol);
        continue;
      }
      i += 1;
      column += 1;
      let out = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === '"') {
          closed = true;
          i += 1;
          column += 1;
          break;
        }
        if (c === '\n') throw new Error(`Unterminated string at ${startLine}:${startCol}`);
        if (c === '\\') {
          const esc = source[i + 1] as string;
          if (esc === 'u') {
            const hex = source.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`Bad unicode escape at ${line}:${column}`);
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            column += 6;
          } else {
            const map: Record<string, string> = {
              '"': '"',
              '\\': '\\',
              '/': '/',
              b: '\b',
              f: '\f',
              n: '\n',
              r: '\r',
              t: '\t',
            };
            out += map[esc] !== undefined ? (map[esc] as string) : esc;
            i += 2;
            column += 2;
          }
          continue;
        }
        out += c;
        i += 1;
        column += 1;
      }
      if (!closed) throw new Error(`Unterminated string at ${startLine}:${startCol}`);
      push('string', out, startLine, startCol);
      continue;
    }
    if (isDigit(ch) || (ch === '-' && isDigit(source[i + 1] as string))) {
      const startLine = line;
      const startCol = column;
      const start = i;
      if (source[i] === '-') {
        i += 1;
        column += 1;
      }
      while (i < source.length && isDigit(source[i] as string)) {
        i += 1;
        column += 1;
      }
      let isFloat = false;
      if (source[i] === '.') {
        isFloat = true;
        i += 1;
        column += 1;
        while (i < source.length && isDigit(source[i] as string)) {
          i += 1;
          column += 1;
        }
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        i += 1;
        column += 1;
        if (source[i] === '+' || source[i] === '-') {
          i += 1;
          column += 1;
        }
        while (i < source.length && isDigit(source[i] as string)) {
          i += 1;
          column += 1;
        }
      }
      push(isFloat ? 'float' : 'int', source.slice(start, i), startLine, startCol);
      continue;
    }
    if (isNameStart(ch)) {
      const startLine = line;
      const startCol = column;
      const start = i;
      while (i < source.length && isNameChar(source[i] as string)) {
        i += 1;
        column += 1;
      }
      push('name', source.slice(start, i), startLine, startCol);
      continue;
    }
    if (ch === '.') {
      if (source.slice(i, i + 3) === '...') {
        push('punct', '...', line, column);
        i += 3;
        column += 3;
        continue;
      }
      throw new Error(`Unexpected character "." at ${line}:${column}`);
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      push('punct', ch, line, column);
      i += 1;
      column += 1;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at ${line}:${column}`);
  }
  tokens.push({ kind: 'eof', value: '', line, column });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; ofType: TypeNode }
  | { kind: 'nonNull'; ofType: TypeNode };

type Selection =
  | {
      kind: 'field';
      name: string;
      alias: string | null;
      args: { name: string; value: ValueNode }[];
      selections: Selection[] | null;
      line: number;
      column: number;
    }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: Selection[] };

interface VarDef {
  name: string;
  type: TypeNode;
  defaultValue: ValueNode | null;
}

interface OperationDef {
  kind: 'operation';
  op: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selections: Selection[];
}

interface FragmentDef {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: Selection[];
}

type Definition = OperationDef | FragmentDef;

interface Document {
  definitions: Definition[];
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

class Parser {
  pos = 0;
  tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }

  atPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }

  eatPunct(value: string): boolean {
    if (this.atPunct(value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectPunct(value: string): Token {
    const t = this.peek();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new Error(`Expected "${value}" but found "${t.value}" at ${t.line}:${t.column}`);
    }
    this.pos += 1;
    return t;
  }

  expectName(what: string): Token {
    const t = this.peek();
    if (t.kind !== 'name') {
      throw new Error(`Expected ${what} but found "${t.value}" at ${t.line}:${t.column}`);
    }
    this.pos += 1;
    return t;
  }

  parseDocument(): Document {
    const definitions: Definition[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return { definitions };
  }

  parseDefinition(): Definition {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', op: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      return this.parseOperation();
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      return this.parseFragment();
    }
    throw new Error(`Unexpected token "${t.value}" at ${t.line}:${t.column}`);
  }

  parseOperation(): OperationDef {
    const kw = this.next();
    const op = kw.value as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    let varDefs: VarDef[] = [];
    if (this.atPunct('(')) varDefs = this.parseVariableDefinitions();
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'operation', op, name, varDefs, selections };
  }

  parseVariableDefinitions(): VarDef[] {
    this.expectPunct('(');
    const defs: VarDef[] = [];
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('Unexpected end of document in variable definitions');
      this.expectPunct('$');
      const nameTok = this.expectName('variable name');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.eatPunct('=')) defaultValue = this.parseValue();
      this.skipDirectives();
      defs.push({ name: nameTok.value, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  parseType(): TypeNode {
    if (this.atPunct('[')) {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let t: TypeNode = { kind: 'list', ofType: inner };
      if (this.eatPunct('!')) t = { kind: 'nonNull', ofType: t };
      return t;
    }
    const nameTok = this.expectName('type name');
    let t: TypeNode = { kind: 'named', name: nameTok.value };
    if (this.eatPunct('!')) t = { kind: 'nonNull', ofType: t };
    return t;
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('Unexpected end of document, expected "}"');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): Selection {
    if (this.atPunct('...')) {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeTok = this.expectName('type name');
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition: typeTok.value, selections: this.parseSelectionSet() };
      }
      if (t.kind === 'name') {
        const nameTok = this.next();
        this.skipDirectives();
        return { kind: 'fragmentSpread', name: nameTok.value };
      }
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.atPunct(':')) {
      this.next();
      const n = this.expectName('field name');
      alias = first.value;
      name = n.value;
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.atPunct('(')) args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] | null = null;
    if (this.atPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections, line: first.line, column: first.column };
  }

  parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('Unexpected end of document in arguments');
      const nameTok = this.expectName('argument name');
      this.expectPunct(':');
      const value = this.parseValue();
      args.push({ name: nameTok.value, value });
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): ValueNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '$') {
      this.next();
      const n = this.expectName('variable name');
      return { kind: 'variable', name: n.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) {
        if (this.peek().kind === 'eof') throw new Error('Unexpected end of document in list value');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        if (this.peek().kind === 'eof') throw new Error('Unexpected end of document in object value');
        const n = this.expectName('field name');
        this.expectPunct(':');
        const v = this.parseValue();
        fields.push({ name: n.value, value: v });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'string', value: t.value };
    }
    if (t.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number(t.value) };
    }
    if (t.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number(t.value) };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Unexpected token "${t.value}" at ${t.line}:${t.column}`);
  }

  skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName('directive name');
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  parseFragment(): FragmentDef {
    this.next();
    const nameTok = this.expectName('fragment name');
    const onTok = this.expectName('"on"');
    if (onTok.value !== 'on') throw new Error(`Expected "on" but found "${onTok.value}" at ${onTok.line}:${onTok.column}`);
    const typeTok = this.expectName('type name');
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'fragment', name: nameTok.value, typeCondition: typeTok.value, selections };
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
}

interface GqlObj {
  __gqlType: string;
  __gqlData: unknown;
}

function obj(type: string, data: unknown): GqlObj {
  return { __gqlType: type, __gqlData: data };
}

function isGqlObj(v: unknown): v is GqlObj {
  return typeof v === 'object' && v !== null && '__gqlType' in v && '__gqlData' in v;
}

interface ExecState {
  store: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
  fragments: Map<string, FragmentDef>;
}

type Resolver = (
  parent: GqlObj,
  args: Record<string, unknown>,
  state: ExecState,
  path: (string | number)[],
) => unknown;

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(
  field: Extract<Selection, { kind: 'field' }>,
  state: ExecState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, state.variables);
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Cursors + connections
// ---------------------------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    if (m === null) return 0;
    return Number(m[1]) + 1;
  } catch {
    return 0;
  }
}

interface PageInfoData {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function makePageInfo(start: number, count: number, total: number): PageInfoData {
  return {
    hasNextPage: start + count < total,
    hasPreviousPage: start > 0,
    startCursor: count > 0 ? encodeCursor(start) : null,
    endCursor: count > 0 ? encodeCursor(start + count - 1) : null,
  };
}

interface IssueConnData {
  repo: Repo;
  issues: Issue[];
  start: number;
  first: number;
  total: number;
}

interface PullConnData {
  repo: Repo;
  pulls: Pull[];
  start: number;
  first: number;
  total: number;
}

interface FilesConnData {
  files: FileChange[];
  first: number;
}

function buildIssueConnection(store: Store, repo: Repo, args: Record<string, unknown>): IssueConnData {
  let list = [...repo.issues];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set((args.states as unknown[]).map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = asRecord(args.orderBy);
  const field = orderBy !== null ? asString(orderBy.field) || 'CREATED_AT' : 'CREATED_AT';
  const direction = orderBy !== null ? asString(orderBy.direction) || 'ASC' : 'ASC';
  const dir = direction === 'DESC' ? -1 : 1;
  const commentCount = (issue: Issue): number =>
    repo.comments.filter((c) => c.issueNumber === issue.number).length;
  list.sort((a, b) => {
    let cmp = 0;
    if (field === 'UPDATED_AT') cmp = a.updatedSeq - b.updatedSeq;
    else if (field === 'COMMENTS') cmp = commentCount(a) - commentCount(b);
    else cmp = a.createdSeq - b.createdSeq;
    if (cmp === 0) cmp = a.createdSeq - b.createdSeq;
    return cmp * dir;
  });
  const first = asNumber(args.first, 10);
  const start = decodeCursor(args.after);
  return { repo, issues: list, start, first, total: list.length };
}

function buildPullConnection(store: Store, repo: Repo, args: Record<string, unknown>): PullConnData {
  void store;
  let list = [...repo.pulls];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set((args.states as unknown[]).map((s) => String(s)));
    list = list.filter((p) => {
      const st = p.merged ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN';
      return wanted.has(st);
    });
  }
  list.sort((a, b) => a.createdSeq - b.createdSeq);
  const first = asNumber(args.first, 10);
  const start = decodeCursor(args.after);
  return { repo, pulls: list, start, first, total: list.length };
}

// ---------------------------------------------------------------------------
// Node lookup + type info (__type)
// ---------------------------------------------------------------------------

interface NodeEntity {
  type: string;
  repo: Repo;
  issue?: Issue;
  pull?: Pull;
  comment?: IssueComment;
}

interface NodeData {
  id: string;
  entity: NodeEntity | null;
}

function lookupNode(store: Store, id: string): NodeEntity | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const repo = store.getRepoById(parsed.repoId);
  if (repo === undefined) return null;
  if (parsed.kind === 'repo') return { type: 'Repository', repo };
  if (parsed.kind === 'issue') {
    const issue = store.getIssue(repo, parsed.number);
    return issue === undefined ? null : { type: 'Issue', repo, issue };
  }
  if (parsed.kind === 'pr') {
    const pull = store.getPull(repo, parsed.number);
    return pull === undefined ? null : { type: 'PullRequest', repo, pull };
  }
  if (parsed.kind === 'comment') {
    const comment = repo.comments.find((c) => c.id === parsed.number);
    return comment === undefined ? null : { type: 'IssueComment', repo, comment };
  }
  return null;
}

function nodeEntityObj(ent: NodeEntity): GqlObj {
  if (ent.type === 'Repository') return obj('Repository', { repo: ent.repo });
  if (ent.type === 'Issue') return obj('Issue', { repo: ent.repo, issue: ent.issue });
  if (ent.type === 'PullRequest') return obj('PullRequest', { repo: ent.repo, pull: ent.pull });
  return obj('IssueComment', { repo: ent.repo, comment: ent.comment });
}

interface TypeData {
  name: string;
  kind: string;
  fields: string[];
  enumValues: string[];
}

const TYPE_INFO: Record<string, TypeData> = {
  Query: { name: 'Query', kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type'], enumValues: [] },
  Mutation: {
    name: 'Mutation',
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    enumValues: [],
  },
  Node: { name: 'Node', kind: 'INTERFACE', fields: ['id'], enumValues: [] },
  User: { name: 'User', kind: 'OBJECT', fields: ['login'], enumValues: [] },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description',
    ],
    enumValues: [],
  },
  Ref: { name: 'Ref', kind: 'OBJECT', fields: ['name'], enumValues: [] },
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'author'],
    enumValues: [],
  },
  IssueConnection: {
    name: 'IssueConnection',
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    enumValues: [],
  },
  IssueEdge: { name: 'IssueEdge', kind: 'OBJECT', fields: ['node', 'cursor'], enumValues: [] },
  PageInfo: {
    name: 'PageInfo',
    kind: 'OBJECT',
    fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
    enumValues: [],
  },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
    enumValues: [],
  },
  PullRequestConnection: {
    name: 'PullRequestConnection',
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    enumValues: [],
  },
  PullRequestEdge: { name: 'PullRequestEdge', kind: 'OBJECT', fields: ['node', 'cursor'], enumValues: [] },
  PullRequestChangedFileConnection: {
    name: 'PullRequestChangedFileConnection',
    kind: 'OBJECT',
    fields: ['nodes', 'totalCount'],
    enumValues: [],
  },
  PullRequestChangedFile: { name: 'PullRequestChangedFile', kind: 'OBJECT', fields: ['path'], enumValues: [] },
  IssueComment: { name: 'IssueComment', kind: 'OBJECT', fields: ['id', 'body'], enumValues: [] },
  IssueCommentEdge: { name: 'IssueCommentEdge', kind: 'OBJECT', fields: ['node', 'cursor'], enumValues: [] },
  CreateIssuePayload: { name: 'CreateIssuePayload', kind: 'OBJECT', fields: ['issue'], enumValues: [] },
  CloseIssuePayload: { name: 'CloseIssuePayload', kind: 'OBJECT', fields: ['issue'], enumValues: [] },
  CreatePullRequestPayload: {
    name: 'CreatePullRequestPayload',
    kind: 'OBJECT',
    fields: ['pullRequest'],
    enumValues: [],
  },
  MergePullRequestPayload: {
    name: 'MergePullRequestPayload',
    kind: 'OBJECT',
    fields: ['pullRequest'],
    enumValues: [],
  },
  AddCommentPayload: { name: 'AddCommentPayload', kind: 'OBJECT', fields: ['commentEdge'], enumValues: [] },
  IssueState: { name: 'IssueState', kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: {
    name: 'PullRequestState',
    kind: 'ENUM',
    fields: [],
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  MergeableState: {
    name: 'MergeableState',
    kind: 'ENUM',
    fields: [],
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  },
  RepositoryPermission: {
    name: 'RepositoryPermission',
    kind: 'ENUM',
    fields: [],
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  },
  SearchType: {
    name: 'SearchType',
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  },
  OrderDirection: { name: 'OrderDirection', kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  IssueOrderField: {
    name: 'IssueOrderField',
    kind: 'ENUM',
    fields: [],
    enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  },
};

function typeInfo(name: string): TypeData {
  const found = TYPE_INFO[name];
  return found !== undefined ? found : { name, kind: 'OBJECT', fields: [], enumValues: [] };
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

// ---------------------------------------------------------------------------
// Field resolvers
// ---------------------------------------------------------------------------

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _args, state) => obj('User', { login: state.store.viewerLogin() }),
    repository: (_parent, args, state) => {
      const repo = state.store.getRepo(asString(args.owner), asString(args.name));
      return repo === undefined ? null : obj('Repository', { repo });
    },
    node: (_parent, args, state) => {
      const id = asString(args.id);
      return obj('Node', { id, entity: lookupNode(state.store, id) } as NodeData);
    },
    __type: (_parent, args) => obj('__Type', typeInfo(asString(args.name))),
  },
  Node: {
    id: (parent) => (parent.__gqlData as NodeData).id,
  },
  __Type: {
    name: (parent) => (parent.__gqlData as TypeData).name,
    kind: (parent) => (parent.__gqlData as TypeData).kind,
    description: () => null,
    fields: (parent) =>
      (parent.__gqlData as TypeData).fields.map((n) => obj('__Field', { name: n })),
    enumValues: (parent) =>
      (parent.__gqlData as TypeData).enumValues.map((n) => obj('__EnumValue', { name: n })),
  },
  __Field: {
    name: (parent) => (parent.__gqlData as { name: string }).name,
    description: () => null,
  },
  __EnumValue: {
    name: (parent) => (parent.__gqlData as { name: string }).name,
    description: () => null,
  },
  User: {
    login: (parent) => (parent.__gqlData as { login: string }).login,
  },
  Repository: {
    id: (parent) => repoGlobalId((parent.__gqlData as { repo: Repo }).repo),
    databaseId: (parent) => (parent.__gqlData as { repo: Repo }).repo.id,
    name: (parent) => (parent.__gqlData as { repo: Repo }).repo.name,
    nameWithOwner: (parent) => {
      const repo = (parent.__gqlData as { repo: Repo }).repo;
      return `${repo.owner}/${repo.name}`;
    },
    description: (parent) => (parent.__gqlData as { repo: Repo }).repo.description,
    owner: (parent) => obj('User', { login: (parent.__gqlData as { repo: Repo }).repo.owner }),
    defaultBranchRef: (parent) =>
      obj('Ref', { name: (parent.__gqlData as { repo: Repo }).repo.defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args, state) => {
      const repo = (parent.__gqlData as { repo: Repo }).repo;
      const issue = state.store.getIssue(repo, asNumber(args.number, Number.NaN));
      return issue === undefined ? null : obj('Issue', { repo, issue });
    },
    issues: (parent, args, state) => {
      const repo = (parent.__gqlData as { repo: Repo }).repo;
      return obj('IssueConnection', buildIssueConnection(state.store, repo, args));
    },
    pullRequests: (parent, args, state) => {
      const repo = (parent.__gqlData as { repo: Repo }).repo;
      return obj('PullRequestConnection', buildPullConnection(state.store, repo, args));
    },
    pullRequest: (parent, args, state) => {
      const repo = (parent.__gqlData as { repo: Repo }).repo;
      const pull = state.store.getPull(repo, asNumber(args.number, Number.NaN));
      return pull === undefined ? null : obj('PullRequest', { repo, pull });
    },
  },
  Ref: {
    name: (parent) => (parent.__gqlData as { name: string }).name,
  },
  Issue: {
    id: (parent) => {
      const d = parent.__gqlData as { repo: Repo; issue: Issue };
      return issueGlobalId(d.repo, d.issue);
    },
    number: (parent) => (parent.__gqlData as { repo: Repo; issue: Issue }).issue.number,
    title: (parent) => (parent.__gqlData as { repo: Repo; issue: Issue }).issue.title,
    body: (parent) => (parent.__gqlData as { repo: Repo; issue: Issue }).issue.body,
    state: (parent) =>
      (parent.__gqlData as { repo: Repo; issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: (parent) =>
      obj('User', { login: (parent.__gqlData as { repo: Repo; issue: Issue }).issue.user }),
  },
  IssueConnection: {
    nodes: (parent) => {
      const d = parent.__gqlData as IssueConnData;
      return d.issues.slice(d.start, d.start + d.first).map((issue) => obj('Issue', { repo: d.repo, issue }));
    },
    edges: (parent) => {
      const d = parent.__gqlData as IssueConnData;
      return d.issues.slice(d.start, d.start + d.first).map((issue, i) =>
        obj('IssueEdge', {
          node: obj('Issue', { repo: d.repo, issue }),
          cursor: encodeCursor(d.start + i),
        }),
      );
    },
    pageInfo: (parent) => {
      const d = parent.__gqlData as IssueConnData;
      const count = Math.max(0, Math.min(d.first, d.total - d.start));
      return obj('PageInfo', makePageInfo(d.start, count, d.total));
    },
    totalCount: (parent) => (parent.__gqlData as IssueConnData).total,
  },
  IssueEdge: {
    node: (parent) => (parent.__gqlData as { node: GqlObj; cursor: string | null }).node,
    cursor: (parent) => (parent.__gqlData as { node: GqlObj; cursor: string | null }).cursor,
  },
  PageInfo: {
    hasNextPage: (parent) => (parent.__gqlData as PageInfoData).hasNextPage,
    hasPreviousPage: (parent) => (parent.__gqlData as PageInfoData).hasPreviousPage,
    startCursor: (parent) => (parent.__gqlData as PageInfoData).startCursor,
    endCursor: (parent) => (parent.__gqlData as PageInfoData).endCursor,
  },
  PullRequest: {
    id: (parent) => {
      const d = parent.__gqlData as { repo: Repo; pull: Pull };
      return pullGlobalId(d.repo, d.pull);
    },
    number: (parent) => (parent.__gqlData as { repo: Repo; pull: Pull }).pull.number,
    title: (parent) => (parent.__gqlData as { repo: Repo; pull: Pull }).pull.title,
    body: (parent) => (parent.__gqlData as { repo: Repo; pull: Pull }).pull.body,
    state: (parent) => pullState((parent.__gqlData as { repo: Repo; pull: Pull }).pull),
    merged: (parent) => (parent.__gqlData as { repo: Repo; pull: Pull }).pull.merged,
    headRefName: (parent) => (parent.__gqlData as { repo: Repo; pull: Pull }).pull.head,
    baseRefName: (parent) => (parent.__gqlData as { repo: Repo; pull: Pull }).pull.base,
    mergeable: (parent, _args, state) => {
      const d = parent.__gqlData as { repo: Repo; pull: Pull };
      return state.store.pullMergeable(d.repo, d.pull);
    },
    files: (parent, args, state) => {
      const d = parent.__gqlData as { repo: Repo; pull: Pull };
      const files = state.store.pullFiles(d.repo, d.pull);
      return obj('PullRequestChangedFileConnection', {
        files,
        first: asNumber(args.first, files.length),
      } as FilesConnData);
    },
  },
  PullRequestConnection: {
    nodes: (parent) => {
      const d = parent.__gqlData as PullConnData;
      return d.pulls.slice(d.start, d.start + d.first).map((pull) => obj('PullRequest', { repo: d.repo, pull }));
    },
    edges: (parent) => {
      const d = parent.__gqlData as PullConnData;
      return d.pulls.slice(d.start, d.start + d.first).map((pull, i) =>
        obj('PullRequestEdge', {
          node: obj('PullRequest', { repo: d.repo, pull }),
          cursor: encodeCursor(d.start + i),
        }),
      );
    },
    pageInfo: (parent) => {
      const d = parent.__gqlData as PullConnData;
      const count = Math.max(0, Math.min(d.first, d.total - d.start));
      return obj('PageInfo', makePageInfo(d.start, count, d.total));
    },
    totalCount: (parent) => (parent.__gqlData as PullConnData).total,
  },
  PullRequestEdge: {
    node: (parent) => (parent.__gqlData as { node: GqlObj; cursor: string | null }).node,
    cursor: (parent) => (parent.__gqlData as { node: GqlObj; cursor: string | null }).cursor,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => {
      const d = parent.__gqlData as FilesConnData;
      return d.files.slice(0, d.first).map((f) => obj('PullRequestChangedFile', { path: f.filename }));
    },
    totalCount: (parent) => (parent.__gqlData as FilesConnData).files.length,
  },
  PullRequestChangedFile: {
    path: (parent) => (parent.__gqlData as { path: string }).path,
  },
  IssueComment: {
    id: (parent) => {
      const d = parent.__gqlData as { repo: Repo; comment: IssueComment };
      return commentGlobalId(d.repo, d.comment);
    },
    body: (parent) => (parent.__gqlData as { repo: Repo; comment: IssueComment }).comment.body,
  },
  IssueCommentEdge: {
    node: (parent) => (parent.__gqlData as { node: GqlObj; cursor: string | null }).node,
    cursor: (parent) => (parent.__gqlData as { node: GqlObj; cursor: string | null }).cursor,
  },
  CreateIssuePayload: {
    issue: (parent) => (parent.__gqlData as { issue: GqlObj }).issue,
  },
  CloseIssuePayload: {
    issue: (parent) => (parent.__gqlData as { issue: GqlObj }).issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => (parent.__gqlData as { pullRequest: GqlObj }).pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => (parent.__gqlData as { pullRequest: GqlObj }).pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (parent) => (parent.__gqlData as { commentEdge: GqlObj }).commentEdge,
  },
  Mutation: {
    createIssue: (_parent, args, state, path) => {
      const input = asRecord(args.input);
      if (input === null) {
        state.errors.push({ message: 'createIssue requires an input object.', path });
        return null;
      }
      const parsed = parseGlobalId(asString(input.repositoryId));
      if (parsed === null || parsed.kind !== 'repo') {
        state.errors.push({ message: 'Repository not found for the given repositoryId.', path });
        return null;
      }
      const repo = state.store.getRepoById(parsed.repoId);
      if (repo === undefined) {
        state.errors.push({ message: 'Repository not found for the given repositoryId.', path });
        return null;
      }
      const title = asString(input.title);
      const body = typeof input.body === 'string' ? input.body : '';
      const labels = Array.isArray(input.labels)
        ? (input.labels as unknown[]).map((l) => String(l))
        : [];
      const created = state.store.createIssue(repo, { title, body, labels });
      if ('error' in created) {
        state.errors.push({ message: `Cannot create issue: unknown label "${created.label}".`, path });
        return null;
      }
      return obj('CreateIssuePayload', { issue: obj('Issue', { repo, issue: created }) });
    },
    closeIssue: (_parent, args, state, path) => {
      const input = asRecord(args.input);
      if (input === null) {
        state.errors.push({ message: 'closeIssue requires an input object.', path });
        return null;
      }
      const parsed = parseGlobalId(asString(input.issueId));
      if (parsed === null || parsed.kind !== 'issue') {
        state.errors.push({ message: 'Issue not found for the given issueId.', path });
        return null;
      }
      const repo = state.store.getRepoById(parsed.repoId);
      if (repo === undefined) {
        state.errors.push({ message: 'Issue not found for the given issueId.', path });
        return null;
      }
      const patched = state.store.patchIssue(repo, parsed.number, { state: 'closed' });
      if (patched === null) {
        state.errors.push({ message: 'Issue not found for the given issueId.', path });
        return null;
      }
      return obj('CloseIssuePayload', { issue: obj('Issue', { repo, issue: patched }) });
    },
    createPullRequest: (_parent, args, state, path) => {
      const input = asRecord(args.input);
      if (input === null) {
        state.errors.push({ message: 'createPullRequest requires an input object.', path });
        return null;
      }
      const parsed = parseGlobalId(asString(input.repositoryId));
      if (parsed === null || parsed.kind !== 'repo') {
        state.errors.push({ message: 'Repository not found for the given repositoryId.', path });
        return null;
      }
      const repo = state.store.getRepoById(parsed.repoId);
      if (repo === undefined) {
        state.errors.push({ message: 'Repository not found for the given repositoryId.', path });
        return null;
      }
      const created = state.store.createPull(repo, {
        head: asString(input.headRefName),
        base: asString(input.baseRefName),
        title: asString(input.title),
        body: typeof input.body === 'string' ? input.body : '',
      });
      if ('error' in created) {
        const what = created.error === 'bad-head' ? 'head ref not found' : 'base ref not found';
        state.errors.push({ message: `Cannot create pull request: ${what}.`, path });
        return null;
      }
      return obj('CreatePullRequestPayload', { pullRequest: obj('PullRequest', { repo, pull: created }) });
    },
    mergePullRequest: (_parent, args, state, path) => {
      const input = asRecord(args.input);
      if (input === null) {
        state.errors.push({ message: 'mergePullRequest requires an input object.', path });
        return null;
      }
      const parsed = parseGlobalId(asString(input.pullRequestId));
      if (parsed === null || parsed.kind !== 'pr') {
        state.errors.push({ message: 'Pull request not found for the given pullRequestId.', path });
        return null;
      }
      const repo = state.store.getRepoById(parsed.repoId);
      if (repo === undefined) {
        state.errors.push({ message: 'Pull request not found for the given pullRequestId.', path });
        return null;
      }
      const pull = state.store.getPull(repo, parsed.number);
      if (pull === undefined) {
        state.errors.push({ message: 'Pull request not found for the given pullRequestId.', path });
        return null;
      }
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
      const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
      const result = state.store.mergePull(repo, pull, method);
      if ('error' in result) {
        if (result.error === 'conflict') {
          state.errors.push({
            message: 'Merge conflict: the pull request cannot be merged cleanly.',
            path,
          });
        } else {
          state.errors.push({ message: 'Pull request is not open and cannot be merged.', path });
        }
        return null;
      }
      return obj('MergePullRequestPayload', { pullRequest: obj('PullRequest', { repo, pull }) });
    },
    addComment: (_parent, args, state, path) => {
      const input = asRecord(args.input);
      if (input === null) {
        state.errors.push({ message: 'addComment requires an input object.', path });
        return null;
      }
      const parsed = parseGlobalId(asString(input.subjectId));
      if (parsed === null || parsed.kind !== 'issue') {
        state.errors.push({ message: 'Issue not found for the given subjectId.', path });
        return null;
      }
      const repo = state.store.getRepoById(parsed.repoId);
      if (repo === undefined) {
        state.errors.push({ message: 'Issue not found for the given subjectId.', path });
        return null;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = state.store.addComment(repo, parsed.number, body);
      if (comment === null) {
        state.errors.push({ message: 'Issue not found for the given subjectId.', path });
        return null;
      }
      return obj('AddCommentPayload', {
        commentEdge: obj('IssueCommentEdge', {
          node: obj('IssueComment', { repo, comment }),
          cursor: null,
        }),
      });
    },
  },
};

// ---------------------------------------------------------------------------
// Selection execution
// ---------------------------------------------------------------------------

function fragmentMatches(typeName: string, parent: GqlObj, condition: string): boolean {
  if (typeName === 'Node') {
    const data = parent.__gqlData as NodeData;
    return data.entity !== null && data.entity.type === condition;
  }
  return condition === typeName;
}

function resolveFieldValue(
  value: unknown,
  selections: Selection[] | null,
  state: ExecState,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (isGqlObj(item)) {
        if (selections === null) return null;
        return resolveSelections(selections, item.__gqlType, item, state, [...path, i]);
      }
      return item;
    });
  }
  if (isGqlObj(value)) {
    if (selections === null) return null;
    return resolveSelections(selections, value.__gqlType, value, state, path);
  }
  return value;
}

function resolveSelections(
  selections: Selection[],
  typeName: string,
  parent: GqlObj,
  state: ExecState,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      if (sel.name === '__typename') {
        let tn = typeName;
        if (typeName === 'Node') {
          const ent = (parent.__gqlData as NodeData).entity;
          if (ent !== null) tn = ent.type;
        }
        out[key] = tn;
        continue;
      }
      const table = RESOLVERS[typeName];
      const resolver = table !== undefined ? table[sel.name] : undefined;
      if (resolver === undefined) {
        state.errors.push({
          message: `Cannot query field "${sel.name}" on type "${typeName}".`,
          path: [...path, key],
          locations: [{ line: sel.line, column: sel.column }],
        });
        continue;
      }
      const args = resolveArgs(sel, state);
      const fieldPath = [...path, key];
      let value: unknown;
      try {
        value = resolver(parent, args, state, fieldPath);
      } catch (e) {
        state.errors.push({
          message: e instanceof Error ? e.message : 'Resolver error',
          path: fieldPath,
        });
        out[key] = null;
        continue;
      }
      out[key] = resolveFieldValue(value, sel.selections, state, fieldPath);
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition === null) {
        Object.assign(out, resolveSelections(sel.selections, typeName, parent, state, path));
      } else if (fragmentMatches(typeName, parent, sel.typeCondition)) {
        let effParent = parent;
        let effType = typeName;
        if (typeName === 'Node') {
          const ent = (parent.__gqlData as NodeData).entity;
          if (ent !== null) {
            effParent = nodeEntityObj(ent);
            effType = sel.typeCondition;
          }
        }
        Object.assign(out, resolveSelections(sel.selections, effType, effParent, state, path));
      }
      continue;
    }
    const def = state.fragments.get(sel.name);
    if (def === undefined) {
      state.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
      continue;
    }
    if (fragmentMatches(typeName, parent, def.typeCondition)) {
      let effParent = parent;
      let effType = typeName;
      if (typeName === 'Node') {
        const ent = (parent.__gqlData as NodeData).entity;
        if (ent !== null) {
          effParent = nodeEntityObj(ent);
          effType = def.typeCondition;
        }
      }
      Object.assign(out, resolveSelections(def.selections, effType, effParent, state, path));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request execution
// ---------------------------------------------------------------------------

function executeOperation(
  doc: Document,
  op: OperationDef,
  variables: Record<string, unknown>,
  store: Store,
): Record<string, unknown> {
  const state: ExecState = { store, variables: { ...variables }, errors: [], fragments: new Map() };
  for (const def of doc.definitions) {
    if (def.kind === 'fragment') state.fragments.set(def.name, def);
  }
  for (const vd of op.varDefs) {
    if (state.variables[vd.name] === undefined && vd.defaultValue !== null) {
      state.variables[vd.name] = resolveValue(vd.defaultValue, state.variables);
    }
  }
  const rootType = op.op === 'mutation' ? 'Mutation' : 'Query';
  const root = obj(rootType, {});
  const data = resolveSelections(op.selections, rootType, root, state, []);
  const out: Record<string, unknown> = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

function executeRequest(op: unknown, store: Store): Record<string, unknown> {
  if (!isRecord(op) || typeof op.query !== 'string') {
    return { data: null, errors: [{ message: 'Request must include a "query" string.' }] };
  }
  const variables = isRecord(op.variables) ? (op.variables as Record<string, unknown>) : {};
  const operationName = typeof op.operationName === 'string' ? op.operationName : null;
  let doc: Document;
  try {
    doc = new Parser(lex(op.query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax error' }] };
  }
  const operations = doc.definitions.filter(
    (d): d is OperationDef => d.kind === 'operation',
  );
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in document.' }] };
  }
  let selected: OperationDef | undefined;
  if (operationName !== null) {
    selected = operations.find((o) => o.name === operationName);
    if (selected === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else {
    selected = operations[0];
  }
  if (selected.op === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported.' }] };
  }
  return executeOperation(doc, selected, variables, store);
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export async function handleGraphQL(ctx: Ctx): Promise<boolean> {
  if (ctx.method !== 'POST' || ctx.path !== '/api/graphql') return false;
  if (!ctx.authed) {
    sendJson(ctx.res, 401, { message: 'Unauthorized' }, ctx.requestId);
    return true;
  }
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendJson(ctx.res, 400, { message: 'Bad Request: malformed JSON body' }, ctx.requestId);
    return true;
  }
  const value = parsed.value;
  const isBatch = Array.isArray(value);
  const ops = isBatch ? (value as unknown[]) : [value];
  const results = ops.map((op) => executeRequest(op, ctx.store));
  sendJson(ctx.res, 200, isBatch ? results : results[0], ctx.requestId);
  return true;
}
