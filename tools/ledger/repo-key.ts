import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitTimedOut, remoteUrls } from './git.js';

// @ref LLP 0001#4-storage — D10: a repo is its remote address, else the path of its main checkout.

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
/** `[user@]host:path`, which git reads as ssh when no slash comes before the colon; an IPv6 host is in brackets. */
const SCP = /^(?:[^@/]*@)?(\[[^\]/]+\]|[^/:[\]]+):(.*)$/;
/** The scp form with no host, such as `git@:team/app`, which names no repo. */
const SCP_WITHOUT_HOST = /^(?:[^@/]*@)?:/;
/** A URL's host, an IPv6 one in brackets, and its port; the user before it is gone. */
const HOST_PORT = /^(\[[^\]]+\]|[^:[\]]+)(?::(.*))?$/;
/** The port a scheme uses when its URL names none, so naming it changes no key. */
const DEFAULT_PORT: Record<string, string> = { ssh: '22', 'git+ssh': '22', git: '9418', http: '80', https: '443' };

/** A key, alias or label that is not empty, holds no \, and has no . or .. between slashes, so no store path climbs out. */
export const isRepoKey = (key: string): boolean => key !== '' && !key.includes('\\') && !key.split('/').some((part) => part === '.' || part === '..');

const withoutGitSuffix = (address: string): string => address.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');

// The whole of it in lowercase: GitHub ignores case in paths, and so does the file store's folder on a default APFS volume.
const hostAndPath = (host: string, rest: string): string => withoutGitSuffix(`${host}/${rest.replace(/^\/+/, '')}`.toLowerCase());

/** `host[:port]` of a URL's authority, without a port that is the scheme's default; undefined without a host or with a port that is no number. */
function hostOf(authority: string, scheme: string): string | undefined {
  const [, host, port] = HOST_PORT.exec(authority.slice(authority.lastIndexOf('@') + 1)) ?? [];
  if (host === undefined || (port !== undefined && !/^\d*$/.test(port))) return undefined;
  return port === undefined || port === '' || port === DEFAULT_PORT[scheme] ? host : `${host}:${port}`;
}

function candidateKey(url: string, base: string): string | undefined {
  const scheme = SCHEME.exec(url)?.[1].toLowerCase();
  if (scheme === 'file') return withoutGitSuffix(fileURLToPath(url));
  if (scheme !== undefined) {
    const [, authority = '', rest = ''] = /^([^/]*)(.*)$/.exec(url.slice(url.indexOf('://') + 3)) ?? [];
    const host = hostOf(authority, scheme);
    return host === undefined ? undefined : hostAndPath(host, rest);
  }
  if (SCP_WITHOUT_HOST.test(url)) return undefined;
  const scp = SCP.exec(url);
  if (scp !== null) return hostAndPath(scp[1], scp[2]);
  return withoutGitSuffix(path.resolve(base, url));
}

/**
 * The store key of a remote address: `host[:port]/path` in lowercase, without scheme, user, `.git` or trailing slash,
 * and the port only when it is not the scheme's default. A local path or file:// URL is the absolute path, `base`
 * resolving a relative one, with its case kept. Undefined for an address that names no host, port, repo path or local file.
 */
export function remoteKey(url: string, base: string): string | undefined {
  try {
    const key = candidateKey(url, base);
    return key !== undefined && key.includes('/') && isRepoKey(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

const keys = new Map<string, string>();

/** The store key of the repo at `main`: the address of origin, else of its only remote, else the path `main`. */
export function repoKey(main: string): string {
  const known = keys.get(main);
  if (known !== undefined) return known;
  const remotes = remoteUrls(main);
  const url = remotes?.get('origin') ?? (remotes?.size === 1 ? [...remotes.values()][0] : undefined);
  const key = (url === undefined ? undefined : remoteKey(url, main)) ?? main;
  // Not kept when git did not answer: a later call may find the remote.
  if (remotes !== undefined || !gitTimedOut(main)) keys.set(main, key);
  return key;
}

/** The key as a person reads it: a remote address without its host, such as chrfalch/ledger; a path's last folder. */
export function repoLabel(key: string): string {
  if (path.isAbsolute(key)) return path.basename(key);
  const slash = key.indexOf('/');
  return slash === -1 ? key : key.slice(slash + 1);
}
