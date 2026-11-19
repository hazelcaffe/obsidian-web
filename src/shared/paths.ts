declare const __BASE_PATH__: string;

export function normalizeBasePath(value: string): string {
	if (!value.startsWith("/") || /[?#\\]/.test(value) || value.split("/").includes("..")) {
		throw new Error("BASE_PATH must be an absolute URL path, such as /obsidian-web/");
	}
	return `${value.replace(/\/+$/, "")}/`;
}

export const BASE_PATH = typeof __BASE_PATH__ === "string" ? normalizeBasePath(__BASE_PATH__) : "/";

export function appUrl(path: string): string {
	return `${BASE_PATH}${path.replace(/^\/+/, "")}`;
}
