declare module "path-browserify" {
	interface ParsedPath {
		root: string;
		dir: string;
		base: string;
		ext: string;
		name: string;
	}
	interface PathModule {
		sep: string;
		delimiter: string;
		resolve(...paths: string[]): string;
		normalize(path: string): string;
		isAbsolute(path: string): boolean;
		join(...paths: string[]): string;
		relative(from: string, to: string): string;
		dirname(path: string): string;
		basename(path: string, ext?: string): string;
		extname(path: string): string;
		format(parts: Partial<ParsedPath>): string;
		parse(path: string): ParsedPath;
		toNamespacedPath(path: string): string;
		posix: PathModule;
		win32?: PathModule;
	}
	const path: PathModule;
	export default path;
}

declare module "querystring-es3" {
	const querystring: {
		parse(input: string, sep?: string, eq?: string): Record<string, string | string[]>;
		stringify(input: Record<string, unknown>, sep?: string, eq?: string): string;
		decode(input: string): Record<string, string | string[]>;
		encode(input: Record<string, unknown>): string;
		escape(input: string): string;
		unescape(input: string): string;
	};
	export default querystring;
}

declare module "browserify-zlib" {
	const zlib: Record<string, unknown>;
	export default zlib;
}
