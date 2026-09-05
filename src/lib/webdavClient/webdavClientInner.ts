import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import type { WebDavImageUploaderSettings } from "../../settings";

/**
 * Maximum number of "create parent directory, then retry" attempts. Bounds the
 * recursion so a persistently failing server cannot cause an infinite loop.
 */
const MAX_RETRY_DEPTH = 3;

/**
 * refer to: https://github.com/perry-mitchell/webdav-client
 */
export class WebDavClientInner {
	private baseUrl: string;
	private authHeader: string;

	constructor(settings: WebDavImageUploaderSettings) {
		const { url, username, password } = settings;
		this.baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;
		if (username && password) {
			const credentials = WebDavClientInner.getToken(username, password);
			this.authHeader = `Basic ${credentials}`;
		} else {
			this.authHeader = "";
		}
	}

	static getToken(username?: string, password?: string) {
		const bytes = new TextEncoder().encode(`${username}:${password}`);
		const binString = String.fromCharCode(...bytes);
		return btoa(binString);
	}

	async putFileContents(
		path: string,
		data: ArrayBuffer | string,
		depth = 0,
	): Promise<boolean> {
		const encodedPath = this.encodePath(path);
		const url = this.buildUrl(encodedPath);

		const response = await this.request({
			url,
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" },
			body: data,
		});

		if (response.status === 412) return false;

		// Parent directory does not exist. Create it and retry, but bound the
		// retries so a persistently failing server can't cause an infinite loop.
		if (response.status === 409 && depth < MAX_RETRY_DEPTH) {
			await this.ensureDirectoryExists(
				path.substring(0, path.lastIndexOf("/")),
			);

			return await this.putFileContents(path, data, depth + 1);
		}

		this.handleResponseCode(response);

		return true;
	}

	async getResource(path: string): Promise<WebDavResource> {
		const encodedPath = this.encodePath(path);
		const url = this.buildUrl(encodedPath);

		const response = await this.request({
			url,
			method: "GET",
		});

		this.handleResponseCode(response);

		return {
			data: response.arrayBuffer,
			contentType: this.getResponseHeader(response, "content-type"),
		};
	}

	async getFileContents(path: string) {
		return (await this.getResource(path)).data;
	}

	async moveFile(oldPath: string, newPath: string, overwrite = false, depth = 0) {
		const url = this.buildUrl(this.encodePath(oldPath));

		if (!overwrite) {
			// BUG: `Overwite: 'F'` header may not working for some WebDAV server
			// check the file manually
			const exists = await this.exists(newPath);
			if (exists) {
				throw new Error(
					`Destination file already exists: '${newPath}'`,
				);
			}
		}

		const newUrl = this.buildUrl(this.encodePath(newPath));

		const response = await this.request({
			url,
			method: "MOVE",
			headers: {
				Destination: newUrl,
				Overwrite: overwrite ? "T" : "F",
			},
		});

		// Parent directory does not exist. Create it and retry, but bound the
		// retries so a persistently failing server can't cause an infinite loop.
		if (
			[404, 409, 500].includes(response.status) &&
			depth < MAX_RETRY_DEPTH
		) {
			await this.ensureDirectoryExists(
				newPath.substring(0, newPath.lastIndexOf("/")),
			);
			await this.moveFile(oldPath, newPath, overwrite, depth + 1);
			return;
		}

		// file already exists
		if (response.status === 412) {
			throw new Error(`Destination file already exists: '${newPath}'`);
		}

		this.handleResponseCode(response);

		return;
	}

	async deleteFile(path: string) {
		const encodedPath = this.encodePath(path);
		const url = this.buildUrl(encodedPath);

		const response = await this.request({
			url,
			method: "DELETE",
		});

		this.handleResponseCode(response);
	}

	async createDirectory(path: string): Promise<RequestUrlResponse> {
		const encodedPath = this.encodePath(path);
		const url = this.buildUrl(encodedPath);

		return await this.request({
			url,
			method: "MKCOL",
		});
	}

	async exists(path: string) {
		const encodedPath = this.encodePath(path);
		const url = this.buildUrl(encodedPath);

		const response = await this.request({
			url,
			method: "HEAD",
		});

		if (response.status >= 200 && response.status < 300) {
			return true;
		}

		if (response.status === 404) {
			return false;
		}

		this.handleResponseCode(response);

		return false;
	}

	async ensureDirectoryExists(path: string) {
		// WebDAV MKCOL cannot create nested paths in one request, so walk the
		// hierarchy one segment at a time. Implementations commonly return 405 or
		// 409 when a collection already exists. Treat both as idempotent and avoid
		// a follow-up HEAD probe, which is not supported reliably by all bridges.
		const directories = path.split("/").filter((dir) => dir !== "");
		let currentPath = "";

		for (const dir of directories) {
			currentPath += "/" + dir;
			const response = await this.createDirectory(currentPath);
			if ([405, 409].includes(response.status)) continue;
			this.handleResponseCode(response);
		}
	}

	async customRequest(
		path: string,
		options: {
			method: string;
			headers?: Record<string, string>;
			body?: ArrayBuffer | string;
		},
	) {
		const { method, headers = {}, body } = options;

		const encodedPath = this.encodePath(path);
		const url = this.buildUrl(encodedPath);

		return await this.request({
			url,
			method,
			headers,
			body,
		});
	}

	private buildUrl(path: string) {
		if (!path.startsWith("/")) {
			path = "/" + path;
		}
		return this.baseUrl + path;
	}

	private encodePath(path: string) {
		return path
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/");
	}

	private async request(options: {
		url: string;
		method: string;
		headers?: Record<string, string>;
		body?: ArrayBuffer | string;
	}) {
		const { url, method, headers = {}, body } = options;

		const requestOptions: RequestUrlParam = {
			url,
			method,
			headers: {
				Authorization: this.authHeader,
				...headers,
			},
			body: body,
			throw: false,
		};

		return await requestUrl(requestOptions);
	}

	private handleResponseCode(response: RequestUrlResponse) {
		// Preserve the historical contract: requestUrl may already have handled
		// redirects, and 207 Multi-Status is valid for WebDAV servers.
		if (response.status >= 400) {
			throw new Error(
				`${response.status} ${response.text ?? "Unknown error"}`,
			);
		}
	}

	private getResponseHeader(
		response: RequestUrlResponse,
		name: string,
	): string | undefined {
		const target = name.toLowerCase();
		for (const [key, value] of Object.entries(response.headers)) {
			if (key.toLowerCase() === target) {
				return value;
			}
		}
		return undefined;
	}
}

export interface WebDavResource {
	data: ArrayBuffer;
	contentType?: string;
}
