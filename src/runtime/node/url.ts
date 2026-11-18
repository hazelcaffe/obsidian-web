import pathModule from "path-browserify";
import querystring from "querystring-es3";

export function pathToFileURL(path: string): URL {
	let resolved = pathModule.resolve(path);
	if (path.endsWith("/") && !resolved.endsWith("/")) {
		resolved += "/";
	}
	const url = new URL("file:///");
	url.pathname = resolved
		.replace(/%/g, "%25")
		.replace(/\\/g, "%5C")
		.replace(/\n/g, "%0A")
		.replace(/\r/g, "%0D")
		.replace(/\t/g, "%09")
		.replace(/#/g, "%23")
		.replace(/\?/g, "%3F");
	return url;
}

export function fileURLToPath(input: string | URL): string {
	const url = typeof input === "string" ? new URL(input) : input;
	if (url.protocol !== "file:") {
		throw Object.assign(new TypeError("The URL must be of scheme file"), { code: "ERR_INVALID_URL_SCHEME" });
	}
	if (url.hostname !== "") {
		throw Object.assign(new TypeError(`File URL host must be "localhost" or empty on ${"linux"}`), {
			code: "ERR_INVALID_FILE_URL_HOST",
		});
	}
	if (/%2f/i.test(url.pathname)) {
		throw Object.assign(new TypeError("File URL path must not include encoded / characters"), {
			code: "ERR_INVALID_FILE_URL_PATH",
		});
	}
	return decodeURIComponent(url.pathname);
}

export interface LegacyUrl {
	protocol: string | null;
	slashes: boolean | null;
	auth: string | null;
	host: string | null;
	port: string | null;
	hostname: string | null;
	hash: string | null;
	search: string | null;
	query: string | Record<string, unknown> | null;
	pathname: string | null;
	path: string | null;
	href: string;
}

const PROTOCOL_PATTERN = /^([a-z][a-z0-9.+-]*:)?(\/\/)?/i;
const SLASHED_PROTOCOLS = new Set(["http:", "https:", "ftp:", "gopher:", "file:", "ws:", "wss:"]);

export function parse(input: string, parseQueryString = false, slashesDenoteHost = false): LegacyUrl {
	const result: LegacyUrl = {
		protocol: null,
		slashes: null,
		auth: null,
		host: null,
		port: null,
		hostname: null,
		hash: null,
		search: null,
		query: parseQueryString ? {} : null,
		pathname: null,
		path: null,
		href: input,
	};
	let rest = input.trim();
	const hashIndex = rest.indexOf("#");
	if (hashIndex >= 0) {
		result.hash = rest.slice(hashIndex);
		rest = rest.slice(0, hashIndex);
	}
	const queryIndex = rest.indexOf("?");
	if (queryIndex >= 0) {
		result.search = rest.slice(queryIndex);
		const raw = rest.slice(queryIndex + 1);
		result.query = parseQueryString ? querystring.parse(raw) : raw;
		rest = rest.slice(0, queryIndex);
	} else if (parseQueryString) {
		result.search = "";
	}
	const match = PROTOCOL_PATTERN.exec(rest);
	const protocol = match?.[1]?.toLowerCase() ?? null;
	const slashes = !!match?.[2];
	if (protocol) {
		result.protocol = protocol;
	}
	rest = rest.slice(match?.[0].length ?? 0);
	const hostless = protocol === "javascript:";
	const slashedProtocol = !!protocol && SLASHED_PROTOCOLS.has(protocol);
	if (!hostless && ((slashes && (protocol || slashesDenoteHost)) || (protocol && !slashedProtocol))) {
		if (slashes) {
			result.slashes = true;
		}
		const end = rest.search(/[/]/);
		let authority = end >= 0 ? rest.slice(0, end) : rest;
		rest = end >= 0 ? rest.slice(end) : "";
		const at = authority.lastIndexOf("@");
		if (at >= 0) {
			result.auth = decodeURIComponent(authority.slice(0, at));
			authority = authority.slice(at + 1);
		}
		result.host = authority.toLowerCase();
		const portMatch = /:(\d*)$/.exec(authority);
		if (portMatch) {
			result.port = portMatch[1] ?? null;
			result.hostname = authority.slice(0, portMatch.index).toLowerCase();
		} else {
			result.hostname = authority.toLowerCase();
		}
		if (!rest && slashedProtocol) {
			rest = "/";
		}
	} else if (slashes) {
		rest = `//${rest}`;
	}
	result.pathname = rest || null;
	result.path = (result.pathname ?? "") + (result.search ?? "") || null;
	result.href = format(result);
	return result;
}

export function format(input: string | URL | Partial<LegacyUrl>): string {
	if (typeof input === "string") {
		return format(parse(input));
	}
	if (input instanceof URL) {
		return input.href;
	}
	let auth = input.auth ? `${encodeURIComponent(input.auth).replace(/%3A/i, ":")}@` : "";
	let protocol = input.protocol ?? "";
	if (protocol && !protocol.endsWith(":")) {
		protocol += ":";
	}
	let host = "";
	if (input.host) {
		host = auth + input.host;
	} else if (input.hostname) {
		host = auth + (input.hostname.includes(":") ? `[${input.hostname}]` : input.hostname);
		if (input.port) {
			host += `:${input.port}`;
		}
	}
	auth = "";
	let pathname = input.pathname ?? "";
	let search = input.search ?? "";
	if (!search && input.query && typeof input.query === "object") {
		const encoded = querystring.stringify(input.query as Record<string, string>);
		search = encoded ? `?${encoded}` : "";
	}
	let hash = input.hash ?? "";
	// Only slashed protocols get "//", unless the URL had them to begin with.
	if ((input.slashes || SLASHED_PROTOCOLS.has(protocol)) && (input.slashes || host)) {
		host = `//${host}`;
		if (pathname && !pathname.startsWith("/")) {
			pathname = `/${pathname}`;
		}
	}
	if (hash && !hash.startsWith("#")) {
		hash = `#${hash}`;
	}
	if (search && !search.startsWith("?")) {
		search = `?${search}`;
	}
	pathname = pathname.replace(/[?#]/g, encodeURIComponent);
	search = search.replace("#", "%23");
	return protocol + host + pathname + search + hash;
}

export function resolve(from: string, to: string): string {
	try {
		const base = new URL(from, "resolve://");
		const resolved = new URL(to, base);
		if (resolved.protocol === "resolve:") {
			const { pathname, search, hash } = resolved;
			return from.startsWith("/") || pathname.startsWith("/") ? pathname + search + hash : pathname.slice(1);
		}
		return resolved.href;
	} catch {
		return to;
	}
}

export function urlToHttpOptions(url: URL): Record<string, unknown> {
	return {
		protocol: url.protocol,
		hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
		hash: url.hash,
		search: url.search,
		pathname: url.pathname,
		path: `${url.pathname}${url.search}`,
		href: url.href,
		port: url.port ? Number(url.port) : undefined,
		auth:
			url.username || url.password
				? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
				: undefined,
	};
}

export const url = {
	URL,
	URLSearchParams,
	parse,
	format,
	resolve,
	resolveObject: (from: string, to: string) => parse(resolve(from, to)),
	fileURLToPath,
	pathToFileURL,
	urlToHttpOptions,
	domainToASCII: (domain: string) => {
		try {
			return new URL(`http://${domain}`).hostname;
		} catch {
			return "";
		}
	},
	domainToUnicode: (domain: string) => domain,
	Url: function Url() {},
};
