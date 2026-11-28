import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path, { join } from "node:path";
import { ServerResponse } from "node:http";
import { Http2ServerRequest, constants } from "node:http2";
import { Readable } from "node:stream";
import { versions } from "node:process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
// node_modules/@hono/node-server/dist/index.mjs
var RequestError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "RequestError";
	}
};
var nonJoinedHeaders = /* @__PURE__ */ new Set([
	"age",
	"authorization",
	"content-length",
	"content-type",
	"etag",
	"expires",
	"from",
	"host",
	"if-modified-since",
	"if-unmodified-since",
	"last-modified",
	"location",
	"max-forwards",
	"proxy-authorization",
	"referer",
	"retry-after",
	"server",
	"user-agent"
]);
var validHeaderName = /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/;
var isHttpWhitespace = (code) => code === 9 || code === 10 || code === 13 || code === 32;
var normalizeHeaderValue = (value) => {
	if (!isHttpWhitespace(value.charCodeAt(0)) && !isHttpWhitespace(value.charCodeAt(value.length - 1))) return value;
	let start = 0;
	let end = value.length;
	while (start < end && isHttpWhitespace(value.charCodeAt(start))) start++;
	while (end > start && isHttpWhitespace(value.charCodeAt(end - 1))) end--;
	return value.slice(start, end);
};
var forbiddenHeaderValue = /[\0\r\n]/;
var GlobalHeaders = globalThis.Headers;
var materializeHeaders = (rawHeaders, HeadersCtor = GlobalHeaders) => {
	const headers = new HeadersCtor();
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const name = rawHeaders[i];
		if (!name.startsWith(":")) headers.append(name, rawHeaders[i + 1]);
	}
	return headers;
};
var RequestHeaders = class {
	#incoming;
	#rawHeaders;
	#headers;
	#invalidValue;
	constructor(incoming) {
		this.#incoming = incoming;
		if (incoming instanceof Http2ServerRequest) this.#rawHeaders = incoming.rawHeaders.slice();
	}
	get #lazyRawHeaders() {
		return this.#rawHeaders ??= this.#incoming.rawHeaders.slice();
	}
	get #native() {
		if (!this.#headers) {
			this.#headers = materializeHeaders(this.#lazyRawHeaders);
			this.#rawHeaders = void 0;
		}
		return this.#headers;
	}
	#normalizedName(name) {
		if (typeof name !== "string") return;
		if (!validHeaderName.test(name)) throw new TypeError(`Invalid header name: ${name}`);
		return name.toLowerCase();
	}
	#lookupHttp1(lowerName) {
		const headers = this.#incoming instanceof Http2ServerRequest ? void 0 : this.#incoming.headers;
		if (!headers || nonJoinedHeaders.has(lowerName) || lowerName === "set-cookie" || lowerName === "__proto__") return;
		if (!Object.hasOwn(headers, lowerName)) return null;
		const rawValue = headers[lowerName];
		if (typeof rawValue === "string") {
			const value = normalizeHeaderValue(rawValue);
			return forbiddenHeaderValue.test(value) ? void 0 : value;
		}
	}
	#lookup(rawHeaders, lowerName) {
		const separator = lowerName === "cookie" ? "; " : ", ";
		let value = null;
		for (let i = 0; i < rawHeaders.length; i += 2) {
			const rawName = rawHeaders[i];
			if (rawName.length === lowerName.length && rawName.toLowerCase() === lowerName) {
				const rawValue = normalizeHeaderValue(rawHeaders[i + 1]);
				if (forbiddenHeaderValue.test(rawValue)) {
					this.#invalidValue = true;
					return;
				}
				value = value === null ? rawValue : value + separator + rawValue;
			}
		}
		return value;
	}
	append(name, value) {
		this.#native.append(name, value);
	}
	delete(name) {
		this.#native.delete(name);
	}
	get(name) {
		const lowerName = this.#normalizedName(name);
		if (lowerName && !this.#headers && !this.#invalidValue) {
			const http1Value = this.#lookupHttp1(lowerName);
			if (http1Value !== void 0) return http1Value;
			const value = this.#lookup(this.#lazyRawHeaders, lowerName);
			if (value !== void 0) return value;
		}
		return this.#native.get(name);
	}
	has(name) {
		const lowerName = this.#normalizedName(name);
		if (lowerName && !this.#headers && !this.#invalidValue) {
			const http1Value = this.#lookupHttp1(lowerName);
			if (http1Value !== void 0) return http1Value !== null;
			const value = this.#lookup(this.#lazyRawHeaders, lowerName);
			if (value !== void 0) return value !== null;
		}
		return this.#native.has(name);
	}
	set(name, value) {
		this.#native.set(name, value);
	}
	getSetCookie() {
		return this.#native.getSetCookie();
	}
	keys() {
		return this.#native.keys();
	}
	values() {
		return this.#native.values();
	}
	entries() {
		return this.#native.entries();
	}
	forEach(callback, thisArg) {
		this.#native.forEach((value, key) => {
			callback.call(thisArg, value, key, this);
		});
	}
	[Symbol.iterator]() {
		return this.entries();
	}
};
Object.defineProperty(RequestHeaders.prototype, Symbol.for("nodejs.util.inspect.custom"), { value: function(depth, options, inspectFn) {
	return `Headers (lightweight) ${inspectFn(Object.fromEntries(this), {
		...options,
		depth: depth == null ? null : depth - 1
	})}`;
} });
Object.setPrototypeOf(RequestHeaders.prototype, GlobalHeaders.prototype);
var newHeadersFromIncoming = (incoming) => globalThis.Headers === GlobalHeaders ? new RequestHeaders(incoming) : materializeHeaders(incoming.rawHeaders, globalThis.Headers);
var reValidRequestUrl = /^\/[!#$&-;=?-\[\]_a-z~]*$/;
var reDotSegment = /\/\.\.?(?:[/?#]|$)/;
var reValidHost = /^[a-z0-9._-]+(?::(?:[1-5]\d{3,4}|[6-9]\d{3}))?$/;
var validateRequestTarget = (target) => {
	const backslash = target.indexOf("\\");
	if (backslash !== -1) {
		const query = target.indexOf("?");
		if (query === -1 || backslash < query) throw new RequestError("Backslash in request path");
	}
};
var buildUrl = (scheme, host, incomingUrl) => {
	const url = `${scheme}://${host}${incomingUrl}`;
	if (!reValidHost.test(host)) {
		validateRequestTarget(incomingUrl);
		const urlObj = new URL(url);
		if (urlObj.hostname.length !== host.length && urlObj.hostname !== (host.includes(":") ? host.replace(/:\d+$/, "") : host).toLowerCase()) throw new RequestError("Invalid host header");
		return urlObj.href;
	} else if (incomingUrl.length === 0) return url + "/";
	else {
		if (incomingUrl.charCodeAt(0) !== 47) throw new RequestError("Invalid URL");
		if (!reValidRequestUrl.test(incomingUrl) || reDotSegment.test(incomingUrl)) {
			validateRequestTarget(incomingUrl);
			return new URL(url).href;
		}
		return url;
	}
};
var toRequestError = (e) => {
	if (e instanceof RequestError) return e;
	return new RequestError(e.message, { cause: e });
};
var GlobalRequest = global.Request;
var Request$1 = class Request$1 extends GlobalRequest {
	static [Symbol.hasInstance](instance) {
		if (this === Request$1) return instance instanceof GlobalRequest || Function.prototype[Symbol.hasInstance].call(this, instance);
		return Function.prototype[Symbol.hasInstance].call(this, instance);
	}
	constructor(input, options) {
		if (typeof input === "object" && getRequestCache in input) {
			const hasReplacementBody = options !== void 0 && "body" in options && options.body != null;
			if (input[bodyConsumedDirectlyKey] && !hasReplacementBody) throw new TypeError("Cannot construct a Request with a Request object that has already been used.");
			input = input[getRequestCache]();
		}
		if (typeof (options?.body)?.getReader !== "undefined") options.duplex ??= "half";
		super(input, options);
	}
};
var wrapBodyStream = Symbol("wrapBodyStream");
var byteExactEncodings = /* @__PURE__ */ new Set([
	"latin1",
	"binary",
	"hex",
	"base64",
	"base64url"
]);
var isByteExactEncoding = (encoding) => encoding === null || byteExactEncodings.has(encoding);
var bodyBufferedBeforeDisconnectKey = Symbol("bodyBufferedBeforeDisconnect");
var bodyBufferedLengthBeforeDisconnectKey = Symbol("bodyBufferedLengthBeforeDisconnect");
var toBufferChunk = (chunk, encoding) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding ?? "utf8");
var isRecoverableDisconnectedIncoming = (incoming) => !(incoming instanceof Http2ServerRequest) && !!incoming.complete && !!incoming.readableAborted && typeof incoming.read === "function" && isByteExactEncoding(incoming.readableEncoding);
var recordBodyBufferedBeforeDisconnect = (incoming) => {
	if (incoming.readableDidRead || !isRecoverableDisconnectedIncoming(incoming)) return;
	const incomingWithRecovery = incoming;
	incomingWithRecovery[bodyBufferedLengthBeforeDisconnectKey] ??= incoming.readableLength;
};
var readBodyBufferedBeforeDisconnect = (incoming, chunks) => {
	if (incoming.readableDidRead && !chunks || !isRecoverableDisconnectedIncoming(incoming)) return;
	const incomingWithRecovery = incoming;
	if (incomingWithRecovery[bodyBufferedBeforeDisconnectKey] !== void 0) return incomingWithRecovery[bodyBufferedBeforeDisconnectKey];
	let result;
	const errored = incoming.errored;
	if (errored && errored.code !== "ECONNRESET") result = errored;
	else if (incomingWithRecovery[bodyBufferedLengthBeforeDisconnectKey] !== void 0 && incoming.readableLength !== incomingWithRecovery[bodyBufferedLengthBeforeDisconnectKey]) result = newBodyUnusableError();
	else {
		const bodyChunks = chunks ?? [];
		let chunk;
		while ((chunk = incoming.read()) !== null) bodyChunks.push(toBufferChunk(chunk, incoming.readableEncoding));
		const buffer = bodyChunks.length === 1 ? bodyChunks[0] : Buffer.concat(bodyChunks);
		result = buffer;
		const contentLength = incoming.headers["content-length"];
		if (typeof contentLength === "string" && /^\d+$/.test(contentLength)) {
			const expectedLength = Number(contentLength);
			if (Number.isSafeInteger(expectedLength) && buffer.length !== expectedLength) result = newBodyUnusableError();
		}
	}
	incomingWithRecovery[bodyBufferedBeforeDisconnectKey] = result;
	return result;
};
var enqueueBufferedBody = (controller, buffered) => {
	if (buffered instanceof Error) {
		controller.error(buffered);
		return;
	}
	if (buffered.length > 0) controller.enqueue(buffered);
	controller.close();
};
var newRequestFromIncoming = (method, url, headers, incoming, abortController) => {
	const init = {
		method,
		headers,
		signal: abortController.signal
	};
	if (method === "TRACE") {
		init.method = "GET";
		const req = new Request$1(url, init);
		Object.defineProperty(req, "method", { get() {
			return "TRACE";
		} });
		return req;
	}
	if (!(method === "GET" || method === "HEAD")) if ("rawBody" in incoming && incoming.rawBody instanceof Buffer) init.body = new ReadableStream({ start(controller) {
		controller.enqueue(incoming.rawBody);
		controller.close();
	} });
	else if (incoming[wrapBodyStream]) {
		let reader;
		init.body = new ReadableStream({ async pull(controller) {
			try {
				if (!reader) {
					const buffered = readBodyBufferedBeforeDisconnect(incoming);
					if (buffered !== void 0) {
						enqueueBufferedBody(controller, buffered);
						return;
					}
				}
				reader ||= Readable.toWeb(incoming).getReader();
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		} });
	} else {
		const buffered = readBodyBufferedBeforeDisconnect(incoming);
		if (buffered !== void 0) init.body = new ReadableStream({ start(controller) {
			enqueueBufferedBody(controller, buffered);
		} });
		else init.body = Readable.toWeb(incoming);
	}
	return new Request$1(url, init);
};
var getRequestCache = Symbol("getRequestCache");
var requestCache = Symbol("requestCache");
var incomingKey = Symbol("incomingKey");
var urlKey = Symbol("urlKey");
var methodKey = Symbol("methodKey");
var headersKey = Symbol("headersKey");
var abortControllerKey = Symbol("abortControllerKey");
var getAbortController = Symbol("getAbortController");
var abortRequest = Symbol("abortRequest");
var bodyBufferKey = Symbol("bodyBuffer");
var bodyReadPromiseKey = Symbol("bodyReadPromise");
var bodyConsumedDirectlyKey = Symbol("bodyConsumedDirectly");
var bodyLockReaderKey = Symbol("bodyLockReader");
var abortReasonKey = Symbol("abortReason");
var newBodyUnusableError = () => {
	return /* @__PURE__ */ new TypeError("Body is unusable");
};
var rejectBodyUnusable = () => {
	return Promise.reject(newBodyUnusableError());
};
var textDecoder = new TextDecoder();
var consumeBodyDirectOnce = (request) => {
	if (request[bodyConsumedDirectlyKey]) return rejectBodyUnusable();
	request[bodyConsumedDirectlyKey] = true;
};
var toArrayBuffer = (buf) => {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};
var contentType = (request) => {
	return (request[headersKey] ||= newHeadersFromIncoming(request[incomingKey])).get("content-type") || "";
};
var methodTokenRegExp = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
var normalizeIncomingMethod = (method) => {
	if (typeof method !== "string" || method.length === 0) return "GET";
	switch (method) {
		case "DELETE":
		case "GET":
		case "HEAD":
		case "OPTIONS":
		case "PATCH":
		case "POST":
		case "PUT":
		case "QUERY": return method;
	}
	const upper = method.toUpperCase();
	switch (upper) {
		case "DELETE":
		case "GET":
		case "HEAD":
		case "OPTIONS":
		case "POST":
		case "PUT": return upper;
		default: return method;
	}
};
var validateDirectReadMethod = (method) => {
	if (!methodTokenRegExp.test(method)) return /* @__PURE__ */ new TypeError(`'${method}' is not a valid HTTP method.`);
	const normalized = method.toUpperCase();
	if (normalized === "CONNECT" || normalized === "TRACK" || normalized === "TRACE" && method !== "TRACE") return /* @__PURE__ */ new TypeError(`'${method}' HTTP method is unsupported.`);
};
var readBodyWithFastPath = (request, method, fromBuffer) => {
	if (request[bodyConsumedDirectlyKey]) return rejectBodyUnusable();
	const methodName = request.method;
	if (methodName === "GET" || methodName === "HEAD") return request[getRequestCache]()[method]();
	const methodValidationError = validateDirectReadMethod(methodName);
	if (methodValidationError) return Promise.reject(methodValidationError);
	if (request[requestCache]) {
		if (methodName !== "TRACE") return request[requestCache][method]();
	}
	const alreadyUsedError = consumeBodyDirectOnce(request);
	if (alreadyUsedError) return alreadyUsedError;
	const raw = readRawBodyIfAvailable(request);
	if (raw) {
		const result = Promise.resolve(fromBuffer(raw, request));
		request[bodyBufferKey] = void 0;
		return result;
	}
	return readBodyDirect(request).then((buf) => {
		const result = fromBuffer(buf, request);
		request[bodyBufferKey] = void 0;
		return result;
	});
};
var readRawBodyIfAvailable = (request) => {
	const incoming = request[incomingKey];
	if ("rawBody" in incoming && incoming.rawBody instanceof Buffer) return incoming.rawBody;
};
var normalizeAbortError = (request, incoming) => {
	if (incoming.errored) return incoming.errored;
	const reason = request[abortReasonKey];
	if (reason !== void 0) return reason instanceof Error ? reason : new Error(String(reason));
	return /* @__PURE__ */ new Error("Client connection prematurely closed.");
};
var readBodyDirect = (request) => {
	if (request[bodyBufferKey]) return Promise.resolve(request[bodyBufferKey]);
	if (request[bodyReadPromiseKey]) return request[bodyReadPromiseKey];
	const incoming = request[incomingKey];
	if (incoming.readableDidRead) return rejectBodyUnusable();
	const buffered = readBodyBufferedBeforeDisconnect(incoming);
	if (buffered !== void 0) {
		if (buffered instanceof Error) return Promise.reject(buffered);
		request[bodyBufferKey] = buffered;
		return Promise.resolve(buffered);
	}
	const promise = new Promise((resolve, reject) => {
		const chunks = [];
		let settled = false;
		const finish = (callback) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const recoverCompleteBodyAfterDisconnect = (error) => {
			const streamError = incoming.errored ?? error;
			if (!isRecoverableDisconnectedIncoming(incoming) || streamError && streamError.code !== "ECONNRESET") return false;
			finish(() => {
				const recovered = readBodyBufferedBeforeDisconnect(incoming, chunks);
				if (recovered instanceof Error) reject(recovered);
				else if (recovered === void 0) reject(error ?? normalizeAbortError(request, incoming));
				else {
					request[bodyBufferKey] = recovered;
					resolve(recovered);
				}
			});
			return true;
		};
		const onData = (chunk) => {
			chunks.push(toBufferChunk(chunk, incoming.readableEncoding));
		};
		const onEnd = () => {
			finish(() => {
				const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
				request[bodyBufferKey] = buffer;
				resolve(buffer);
			});
		};
		const onError = (error) => {
			if (recoverCompleteBodyAfterDisconnect(error)) return;
			finish(() => {
				reject(error);
			});
		};
		const onClose = () => {
			if (incoming.readableEnded) {
				onEnd();
				return;
			}
			if (recoverCompleteBodyAfterDisconnect()) return;
			finish(() => {
				reject(normalizeAbortError(request, incoming));
			});
		};
		const cleanup = () => {
			incoming.off("data", onData);
			incoming.off("end", onEnd);
			incoming.off("error", onError);
			incoming.off("close", onClose);
			request[bodyReadPromiseKey] = void 0;
		};
		incoming.on("data", onData);
		incoming.on("end", onEnd);
		incoming.on("error", onError);
		incoming.on("close", onClose);
		queueMicrotask(() => {
			if (settled) return;
			if (incoming.readableEnded) onEnd();
			else if (incoming.errored) onError(incoming.errored);
			else if (incoming.destroyed) onClose();
		});
	});
	request[bodyReadPromiseKey] = promise;
	return promise;
};
var requestPrototype = {
	get method() {
		return this[methodKey];
	},
	get url() {
		return this[urlKey];
	},
	get headers() {
		return this[headersKey] ||= newHeadersFromIncoming(this[incomingKey]);
	},
	[abortRequest](reason) {
		if (this[abortReasonKey] === void 0) this[abortReasonKey] = reason;
		const abortController = this[abortControllerKey];
		if (abortController && !abortController.signal.aborted) abortController.abort(reason);
	},
	[getAbortController]() {
		this[abortControllerKey] ||= new AbortController();
		if (this[abortReasonKey] !== void 0 && !this[abortControllerKey].signal.aborted) this[abortControllerKey].abort(this[abortReasonKey]);
		return this[abortControllerKey];
	},
	[getRequestCache]() {
		const abortController = this[getAbortController]();
		if (this[requestCache]) return this[requestCache];
		const method = this.method;
		if (this[bodyConsumedDirectlyKey] && !(method === "GET" || method === "HEAD")) {
			this[bodyBufferKey] = void 0;
			const init = {
				method: method === "TRACE" ? "GET" : method,
				headers: this.headers,
				signal: abortController.signal
			};
			if (method !== "TRACE") {
				init.body = new ReadableStream({ start(c) {
					c.close();
				} });
				init.duplex = "half";
			}
			const req = new Request$1(this[urlKey], init);
			if (method === "TRACE") Object.defineProperty(req, "method", { get() {
				return "TRACE";
			} });
			return this[requestCache] = req;
		}
		return this[requestCache] = newRequestFromIncoming(this.method, this[urlKey], this.headers, this[incomingKey], abortController);
	},
	get body() {
		if (!this[bodyConsumedDirectlyKey]) return this[getRequestCache]().body;
		const request = this[getRequestCache]();
		if (!this[bodyLockReaderKey] && request.body) this[bodyLockReaderKey] = request.body.getReader();
		return request.body;
	},
	get bodyUsed() {
		if (this[bodyConsumedDirectlyKey]) return true;
		if (this[requestCache]) return this[requestCache].bodyUsed;
		return false;
	}
};
Object.defineProperty(requestPrototype, "signal", { get() {
	return this[getAbortController]().signal;
} });
[
	"cache",
	"credentials",
	"destination",
	"duplex",
	"integrity",
	"mode",
	"redirect",
	"referrer",
	"referrerPolicy",
	"keepalive"
].forEach((k) => {
	Object.defineProperty(requestPrototype, k, { get() {
		return this[getRequestCache]()[k];
	} });
});
["clone", "formData"].forEach((k) => {
	Object.defineProperty(requestPrototype, k, { value: function() {
		if (this[bodyConsumedDirectlyKey]) {
			if (k === "clone") throw newBodyUnusableError();
			return rejectBodyUnusable();
		}
		return this[getRequestCache]()[k]();
	} });
});
Object.defineProperty(requestPrototype, "text", { value: function() {
	return readBodyWithFastPath(this, "text", (buf) => textDecoder.decode(buf));
} });
Object.defineProperty(requestPrototype, "arrayBuffer", { value: function() {
	return readBodyWithFastPath(this, "arrayBuffer", (buf) => toArrayBuffer(buf));
} });
Object.defineProperty(requestPrototype, "blob", { value: function() {
	return readBodyWithFastPath(this, "blob", (buf, request) => {
		const type = contentType(request);
		return new Response(buf, type ? { headers: { "content-type": type } } : void 0).blob();
	});
} });
Object.defineProperty(requestPrototype, "bytes", { value: function() {
	return this.arrayBuffer().then((buf) => new Uint8Array(buf));
} });
Object.defineProperty(requestPrototype, "json", { value: function() {
	if (this[bodyConsumedDirectlyKey]) return rejectBodyUnusable();
	return this.text().then(JSON.parse);
} });
Object.defineProperty(requestPrototype, Symbol.for("nodejs.util.inspect.custom"), { value: function(depth, options, inspectFn) {
	return `Request (lightweight) ${inspectFn({
		method: this.method,
		url: this.url,
		headers: this.headers,
		nativeRequest: this[requestCache]
	}, {
		...options,
		depth: depth == null ? null : depth - 1
	})}`;
} });
Object.setPrototypeOf(requestPrototype, Request$1.prototype);
var newRequest = (incoming, defaultHostname) => {
	const req = Object.create(requestPrototype);
	req[incomingKey] = incoming;
	req[methodKey] = normalizeIncomingMethod(incoming.method);
	const incomingUrl = incoming.url || "";
	if (incomingUrl[0] !== "/" && (incomingUrl.startsWith("http://") || incomingUrl.startsWith("https://"))) {
		if (incoming instanceof Http2ServerRequest) throw new RequestError("Absolute URL for :path is not allowed in HTTP/2");
		try {
			validateRequestTarget(incomingUrl);
			req[urlKey] = new URL(incomingUrl).href;
		} catch (e) {
			throw new RequestError("Invalid absolute URL", { cause: e });
		}
		return req;
	}
	const host = (incoming instanceof Http2ServerRequest ? incoming.authority : incoming.headers.host) || defaultHostname;
	if (!host) throw new RequestError("Missing host header");
	let scheme;
	if (incoming instanceof Http2ServerRequest) {
		scheme = incoming.scheme;
		if (!(scheme === "http" || scheme === "https")) throw new RequestError("Unsupported scheme");
	} else scheme = incoming.socket && incoming.socket.encrypted ? "https" : "http";
	try {
		req[urlKey] = buildUrl(scheme, host, incomingUrl);
	} catch (e) {
		if (e instanceof RequestError) throw e;
		else throw new RequestError("Invalid URL", { cause: e });
	}
	return req;
};
var defaultContentType = "text/plain; charset=UTF-8";
var responseCache = Symbol("responseCache");
var getResponseCache = Symbol("getResponseCache");
var cacheKey = Symbol("cache");
var GlobalResponse = global.Response;
var Response$1 = class Response$1 {
	#body;
	#init;
	static [Symbol.hasInstance](instance) {
		if (this === Response$1) return instance instanceof GlobalResponse || Function.prototype[Symbol.hasInstance].call(this, instance);
		return Function.prototype[Symbol.hasInstance].call(this, instance);
	}
	[getResponseCache]() {
		const cache = this[cacheKey];
		const liveHeaders = cache && cache[2] instanceof Headers ? cache[2] : void 0;
		delete this[cacheKey];
		return this[responseCache] ||= new GlobalResponse(this.#body, liveHeaders ? {
			status: this.#init?.status,
			statusText: this.#init?.statusText,
			headers: liveHeaders
		} : this.#init);
	}
	constructor(body, init) {
		let headers;
		this.#body = body;
		if (init instanceof GlobalResponse) {
			const cachedGlobalResponse = init[responseCache];
			if (cachedGlobalResponse) {
				this.#init = cachedGlobalResponse;
				this[getResponseCache]();
				return;
			}
			this.#init = #init in init ? init.#init : init;
			headers = new Headers(init.headers);
		} else this.#init = init;
		if (body == null || typeof body === "string" || typeof body?.getReader !== "undefined" || body instanceof Blob || body instanceof Uint8Array) this[cacheKey] = [
			init?.status || 200,
			body ?? null,
			headers || init?.headers
		];
	}
	get headers() {
		const cache = this[cacheKey];
		if (cache) {
			if (!(cache[2] instanceof Headers)) cache[2] = new Headers(cache[2] || (cache[1] === null ? void 0 : { "content-type": defaultContentType }));
			return cache[2];
		}
		return this[getResponseCache]().headers;
	}
	get status() {
		return this[cacheKey]?.[0] ?? this[getResponseCache]().status;
	}
	get ok() {
		const status = this.status;
		return status >= 200 && status < 300;
	}
};
[
	"body",
	"bodyUsed",
	"redirected",
	"statusText",
	"trailers",
	"type",
	"url"
].forEach((k) => {
	Object.defineProperty(Response$1.prototype, k, { get() {
		return this[getResponseCache]()[k];
	} });
});
[
	"arrayBuffer",
	"blob",
	"bytes",
	"clone",
	"formData",
	"json",
	"text"
].forEach((k) => {
	Object.defineProperty(Response$1.prototype, k, { value: function() {
		return this[getResponseCache]()[k]();
	} });
});
Object.defineProperty(Response$1.prototype, Symbol.for("nodejs.util.inspect.custom"), { value: function(depth, options, inspectFn) {
	return `Response (lightweight) ${inspectFn({
		status: this.status,
		headers: this.headers,
		ok: this.ok,
		nativeResponse: this[responseCache]
	}, {
		...options,
		depth: depth == null ? null : depth - 1
	})}`;
} });
Object.setPrototypeOf(Response$1, GlobalResponse);
Object.setPrototypeOf(Response$1.prototype, GlobalResponse.prototype);
var validRedirectUrl = /^https?:\/\/[!#-;=?-[\]_a-z~A-Z]+$/;
var parseRedirectUrl = (url) => {
	if (url instanceof URL) return url.href;
	if (validRedirectUrl.test(url)) return url;
	return new URL(url).href;
};
var validRedirectStatuses = /* @__PURE__ */ new Set([
	301,
	302,
	303,
	307,
	308
]);
Object.defineProperty(Response$1, "redirect", {
	value: function redirect(url, status = 302) {
		if (!validRedirectStatuses.has(status)) throw new RangeError("Invalid status code");
		return new Response$1(null, {
			status,
			headers: { location: parseRedirectUrl(url) }
		});
	},
	writable: true,
	configurable: true
});
Object.defineProperty(Response$1, "json", {
	value: function json(data, init) {
		const body = JSON.stringify(data);
		if (body === void 0) throw new TypeError("The data is not JSON serializable");
		const initHeaders = init?.headers;
		let headers;
		if (initHeaders) {
			headers = new Headers(initHeaders);
			if (!headers.has("content-type")) headers.set("content-type", "application/json");
		} else headers = { "content-type": "application/json" };
		return new Response$1(body, {
			status: init?.status ?? 200,
			statusText: init?.statusText,
			headers
		});
	},
	writable: true,
	configurable: true
});
async function readWithoutBlocking(readPromise) {
	return Promise.race([readPromise, Promise.resolve().then(() => Promise.resolve(void 0))]);
}
function writeFromReadableStreamDefaultReader(reader, writable, currentReadPromise) {
	const cancel = (error) => {
		reader.cancel(error).catch(() => {});
	};
	const stream = writable.stream;
	if (writable.destroyed || stream?.closed || stream?.destroyed) {
		cancel();
		return reader.closed;
	}
	writable.on("close", cancel);
	writable.on("error", cancel);
	(currentReadPromise ?? reader.read()).then(flow, handleStreamError);
	return reader.closed.finally(() => {
		writable.off("close", cancel);
		writable.off("error", cancel);
	});
	function handleStreamError(error) {
		if (error) writable.destroy(error);
	}
	function onDrain() {
		reader.read().then(flow, handleStreamError);
	}
	function flow({ done, value }) {
		try {
			if (done) writable.end();
			else if (!writable.write(value)) writable.once("drain", onDrain);
			else reader.read().then(flow, handleStreamError);
		} catch (e) {
			handleStreamError(e);
		}
	}
}
function writeFromReadableStream(stream, writable) {
	if (stream.locked) throw new TypeError("ReadableStream is locked.");
	else if (writable.destroyed) {
		stream.cancel().catch(() => {});
		return;
	}
	return writeFromReadableStreamDefaultReader(stream.getReader(), writable);
}
var buildOutgoingHttpHeaders = (headers, defaultContentType) => {
	const res = {};
	if (!(headers instanceof Headers)) headers = new Headers(headers ?? void 0);
	if (headers.has("set-cookie")) {
		const cookies = [];
		for (const [k, v] of headers) if (k === "set-cookie") cookies.push(v);
		else res[k] = v;
		if (cookies.length > 0) res["set-cookie"] = cookies;
	} else for (const [k, v] of headers) res[k] = v;
	if (defaultContentType) res["content-type"] ??= defaultContentType;
	return res;
};
var outgoingEnded = Symbol("outgoingEnded");
var incomingDraining = Symbol("incomingDraining");
var DRAIN_TIMEOUT_MS = 500;
var MAX_DRAIN_BYTES = 67108864;
var drainIncoming = (incoming) => {
	const incomingWithDrainState = incoming;
	if (incoming.destroyed || incomingWithDrainState[incomingDraining]) return;
	incomingWithDrainState[incomingDraining] = true;
	if (incoming instanceof Http2ServerRequest) {
		try {
			incoming.stream?.close?.(constants.NGHTTP2_NO_ERROR);
		} catch {}
		return;
	}
	let bytesRead = 0;
	const cleanup = () => {
		clearTimeout(timer);
		incoming.off("data", onData);
		incoming.off("end", cleanup);
		incoming.off("error", cleanup);
	};
	const forceClose = () => {
		cleanup();
		const socket = incoming.socket;
		if (socket && !socket.destroyed) {
			if (typeof socket.destroySoon === "function") socket.destroySoon();
			else if (typeof socket.destroy === "function") socket.destroy();
		}
	};
	const timer = setTimeout(forceClose, DRAIN_TIMEOUT_MS);
	timer.unref?.();
	const onData = (chunk) => {
		bytesRead += chunk.length;
		if (bytesRead > MAX_DRAIN_BYTES) forceClose();
	};
	incoming.on("data", onData);
	incoming.on("end", cleanup);
	incoming.on("error", cleanup);
	incoming.resume();
};
var makeCloseHandler = (req, incoming, outgoing, needsBodyCleanup) => () => {
	if (incoming.errored) {
		recordBodyBufferedBeforeDisconnect(incoming);
		req[abortRequest](incoming.errored.toString());
	} else if (!outgoing.writableFinished || incoming instanceof Http2ServerRequest && incoming.aborted) {
		recordBodyBufferedBeforeDisconnect(incoming);
		req[abortRequest]("Client connection prematurely closed.");
	}
	if (needsBodyCleanup && !incoming.readableEnded) setTimeout(() => {
		if (!incoming.readableEnded) setTimeout(() => {
			drainIncoming(incoming);
		});
	});
};
var isImmediateCacheableResponse = (res) => {
	if (!(cacheKey in res)) return false;
	const body = res[cacheKey][1];
	return body === null || typeof body === "string" || body instanceof Uint8Array;
};
var handleRequestError = () => new Response(null, { status: 400 });
var handleFetchError = (e) => new Response(null, { status: e instanceof Error && (e.name === "TimeoutError" || e.constructor.name === "TimeoutError") ? 504 : 500 });
var handleResponseError = (e, outgoing) => {
	const err = e instanceof Error ? e : new Error("unknown error", { cause: e });
	if (err.code === "ERR_STREAM_PREMATURE_CLOSE") console.info("The user aborted a request.");
	else {
		console.error(e);
		if (!outgoing.headersSent) {
			if (outgoing instanceof ServerResponse) outgoing._contentLength = null;
			outgoing.writeHead(500, { "Content-Type": "text/plain" });
		}
		outgoing.end(`Error: ${err.message}`);
		outgoing.destroy(err);
	}
};
var flushHeaders = (outgoing) => {
	if ("flushHeaders" in outgoing && outgoing.writable) outgoing.flushHeaders();
};
var trySetContentLength = (outgoing, status, length) => {
	const http1 = outgoing;
	if (http1._contentLength === null && http1._hasBody && http1.useChunkedEncodingByDefault && !http1._removedContLen && status >= 200 && status !== 204 && status !== 304 && !outgoing.hasHeader("content-length") && !outgoing.hasHeader("transfer-encoding") && !outgoing.hasHeader("trailer")) {
		http1._contentLength = length;
		return true;
	}
	return false;
};
var writeDefaultHeaders = (outgoing, status, length) => {
	if (trySetContentLength(outgoing, status, length)) outgoing.writeHead(status, { "Content-Type": defaultContentType });
	else outgoing.writeHead(status, {
		"Content-Type": defaultContentType,
		"Content-Length": length
	});
};
var responseViaCache = async (res, outgoing) => {
	let [status, body, header] = res[cacheKey];
	if (!header) {
		if (body === null) {
			outgoing.writeHead(status);
			outgoing.end();
		} else if (typeof body === "string") {
			writeDefaultHeaders(outgoing, status, Buffer.byteLength(body));
			outgoing.end(body);
		} else if (body instanceof Uint8Array) {
			writeDefaultHeaders(outgoing, status, body.byteLength);
			outgoing.end(body);
		} else if (body instanceof Blob) {
			writeDefaultHeaders(outgoing, status, body.size);
			outgoing.end(new Uint8Array(await body.arrayBuffer()));
		} else {
			outgoing.writeHead(status, { "Content-Type": defaultContentType });
			flushHeaders(outgoing);
			await writeFromReadableStream(body, outgoing)?.catch((e) => handleResponseError(e, outgoing));
		}
		outgoing[outgoingEnded]?.();
		return;
	}
	let hasContentLength = false;
	let plainHeaders = false;
	let canAutoLength = true;
	if (header instanceof Headers) {
		hasContentLength = header.has("content-length");
		header = buildOutgoingHttpHeaders(header, body === null ? void 0 : defaultContentType);
	} else if (Array.isArray(header)) {
		const headerObj = new Headers(header);
		hasContentLength = headerObj.has("content-length");
		header = buildOutgoingHttpHeaders(headerObj, body === null ? void 0 : defaultContentType);
	} else {
		plainHeaders = true;
		for (const key in header) {
			if (key.length === 14 && key.toLowerCase() === "content-length") {
				hasContentLength = true;
				break;
			}
			if (key.length === 17 && key.toLowerCase() === "transfer-encoding" || key.length === 7 && key.toLowerCase() === "trailer") canAutoLength = false;
		}
	}
	if (!hasContentLength) {
		let length;
		if (typeof body === "string") length = Buffer.byteLength(body);
		else if (body instanceof Uint8Array) length = body.byteLength;
		else if (body instanceof Blob) length = body.size;
		if (length !== void 0 && (!plainHeaders || !canAutoLength || !trySetContentLength(outgoing, status, length))) {
			if (plainHeaders) header = { ...header };
			header["Content-Length"] = length;
		}
	}
	outgoing.writeHead(status, header);
	if (body == null) outgoing.end();
	else if (typeof body === "string" || body instanceof Uint8Array) outgoing.end(body);
	else if (body instanceof Blob) outgoing.end(new Uint8Array(await body.arrayBuffer()));
	else {
		flushHeaders(outgoing);
		await writeFromReadableStream(body, outgoing)?.catch((e) => handleResponseError(e, outgoing));
	}
	outgoing[outgoingEnded]?.();
};
var isPromise = (res) => typeof res.then === "function";
var responseViaResponseObject = async (res, outgoing, options = {}) => {
	if (isPromise(res)) if (options.errorHandler) try {
		res = await res;
	} catch (err) {
		const errRes = await options.errorHandler(err);
		if (!errRes) return;
		res = errRes;
	}
	else res = await res.catch(handleFetchError);
	if (cacheKey in res) return responseViaCache(res, outgoing);
	const resHeaderRecord = buildOutgoingHttpHeaders(res.headers, res.body === null ? void 0 : defaultContentType);
	if (res.body) {
		const reader = res.body.getReader();
		const values = [];
		let done = false;
		let currentReadPromise = void 0;
		if (resHeaderRecord["transfer-encoding"] !== "chunked") {
			let maxReadCount = 2;
			for (let i = 0; i < maxReadCount; i++) {
				currentReadPromise ||= reader.read();
				const chunk = await readWithoutBlocking(currentReadPromise);
				if (!chunk) {
					if (i === 1) {
						await new Promise((resolve) => setTimeout(resolve));
						maxReadCount = 3;
						continue;
					}
					break;
				}
				currentReadPromise = void 0;
				if (chunk.value) values.push(chunk.value);
				if (chunk.done) {
					done = true;
					break;
				}
			}
			if (done && !("content-length" in resHeaderRecord)) resHeaderRecord["content-length"] = values.reduce((acc, value) => acc + value.length, 0);
		}
		outgoing.writeHead(res.status, resHeaderRecord);
		values.forEach((value) => {
			outgoing.write(value);
		});
		if (done) outgoing.end();
		else {
			if (values.length === 0) flushHeaders(outgoing);
			await writeFromReadableStreamDefaultReader(reader, outgoing, currentReadPromise);
		}
	} else if (resHeaderRecord["x-hono-already-sent"]) {} else {
		outgoing.writeHead(res.status, resHeaderRecord);
		outgoing.end();
	}
	outgoing[outgoingEnded]?.();
};
var getRequestListener = (fetchCallback, options = {}) => {
	const autoCleanupIncoming = options.autoCleanupIncoming ?? true;
	if (options.overrideGlobalObjects !== false && global.Request !== Request$1) {
		Object.defineProperty(global, "Request", { value: Request$1 });
		Object.defineProperty(global, "Response", { value: Response$1 });
	}
	return async (incoming, outgoing) => {
		let res, req;
		let needsBodyCleanup = false;
		let closeHandlerAttached = false;
		const ensureCloseHandler = () => {
			if (!req || closeHandlerAttached) return;
			closeHandlerAttached = true;
			outgoing.on("close", makeCloseHandler(req, incoming, outgoing, needsBodyCleanup));
		};
		try {
			req = newRequest(incoming, options.hostname);
			needsBodyCleanup = autoCleanupIncoming && !(incoming.method === "GET" || incoming.method === "HEAD");
			if (needsBodyCleanup) {
				incoming[wrapBodyStream] = true;
				if (incoming instanceof Http2ServerRequest) outgoing[outgoingEnded] = () => {
					if (!incoming.readableEnded) setTimeout(() => {
						if (!incoming.readableEnded) setTimeout(() => {
							incoming.destroy();
							outgoing.destroy();
						});
					});
				};
			}
			res = fetchCallback(req, {
				incoming,
				outgoing
			});
			if (!isPromise(res) && isImmediateCacheableResponse(res)) {
				if (needsBodyCleanup && !incoming.readableEnded) outgoing.once("finish", () => {
					if (!incoming.readableEnded) drainIncoming(incoming);
				});
				return responseViaCache(res, outgoing);
			}
			ensureCloseHandler();
		} catch (e) {
			if (!res) if (options.errorHandler) {
				ensureCloseHandler();
				res = await options.errorHandler(req ? e : toRequestError(e));
				if (!res) return;
			} else if (!req) res = handleRequestError();
			else res = handleFetchError(e);
			else return handleResponseError(e, outgoing);
		}
		try {
			return await responseViaResponseObject(res, outgoing, options);
		} catch (e) {
			return handleResponseError(e, outgoing);
		}
	};
};
globalThis.CloseEvent;
globalThis.ErrorEvent;
// node_modules/@hono/node-server/dist/utils/stream.mjs
var pr54206Applied = () => {
	const [major, minor] = versions.node.split(".").map((component) => parseInt(component));
	return major >= 23 || major === 22 && minor >= 7 || major === 20 && minor >= 18;
};
var useReadableToWeb = pr54206Applied();
var createStreamBody = (stream, useNativeReadableToWeb = useReadableToWeb) => {
	if (useNativeReadableToWeb) return Readable.toWeb(stream);
	let controller;
	let settled = false;
	const cleanup = () => {
		stream.off("data", onData);
		stream.off("error", onError);
		stream.off("end", onTerminate);
		stream.off("close", onTerminate);
	};
	const settle = (callback) => {
		if (settled) return;
		settled = true;
		cleanup();
		callback?.();
	};
	const onData = (chunk) => {
		if (settled || !controller) return;
		controller.enqueue(chunk);
		if ((controller.desiredSize ?? 0) <= 0) stream.pause();
	};
	const onError = (error) => {
		settle(() => {
			controller?.error(error);
		});
	};
	const onTerminate = () => {
		settle(() => {
			controller?.close();
		});
	};
	return new ReadableStream({
		start(streamController) {
			controller = streamController;
			stream.on("data", onData);
			stream.on("error", onError);
			stream.on("end", onTerminate);
			stream.on("close", onTerminate);
			stream.pause();
		},
		pull() {
			if (!settled) stream.resume();
		},
		cancel() {
			settle();
			const ignoreError = () => {};
			stream.on("error", ignoreError);
			stream.once("close", () => stream.off("error", ignoreError));
			stream.destroy();
		}
	});
};
// node_modules/hono/dist/utils/mime.js
/**
* @module
* MIME utility.
*/
var getMimeType = (filename, mimes = baseMimes) => {
	const match = filename.match(/\.([a-zA-Z0-9]+?)$/);
	if (!match) return;
	return mimes[match[1].toLowerCase()];
};
var baseMimes = {
	aac: "audio/aac",
	avi: "video/x-msvideo",
	avif: "image/avif",
	av1: "video/av1",
	bin: "application/octet-stream",
	bmp: "image/bmp",
	css: "text/css; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	eot: "application/vnd.ms-fontobject",
	epub: "application/epub+zip",
	gif: "image/gif",
	gz: "application/gzip",
	htm: "text/html; charset=utf-8",
	html: "text/html; charset=utf-8",
	ico: "image/x-icon",
	ics: "text/calendar; charset=utf-8",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	js: "text/javascript; charset=utf-8",
	json: "application/json",
	jsonld: "application/ld+json",
	map: "application/json",
	mid: "audio/x-midi",
	midi: "audio/x-midi",
	mjs: "text/javascript; charset=utf-8",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	mpeg: "video/mpeg",
	oga: "audio/ogg",
	ogv: "video/ogg",
	ogx: "application/ogg",
	opus: "audio/opus",
	otf: "font/otf",
	pdf: "application/pdf",
	png: "image/png",
	rtf: "application/rtf",
	svg: "image/svg+xml; charset=utf-8",
	tif: "image/tiff",
	tiff: "image/tiff",
	ts: "video/mp2t",
	ttf: "font/ttf",
	txt: "text/plain; charset=utf-8",
	wasm: "application/wasm",
	webm: "video/webm",
	weba: "audio/webm",
	webmanifest: "application/manifest+json",
	webp: "image/webp",
	woff: "font/woff",
	woff2: "font/woff2",
	xhtml: "application/xhtml+xml; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	zip: "application/zip",
	"3gp": "video/3gpp",
	"3g2": "video/3gpp2",
	gltf: "model/gltf+json",
	glb: "model/gltf-binary"
};
// node_modules/@hono/node-server/dist/serve-static.mjs
var COMPRESSIBLE_CONTENT_TYPE_REGEX$1 = /^\s*(?:text\/[^;\s]+|application\/(?:javascript|json|xml|xml-dtd|ecmascript|dart|postscript|rtf|tar|toml|vnd\.dart|vnd\.ms-fontobject|vnd\.ms-opentype|wasm|x-httpd-php|x-javascript|x-ns-proxy-autoconfig|x-sh|x-tar|x-virtualbox-hdd|x-virtualbox-ova|x-virtualbox-ovf|x-virtualbox-vbox|x-virtualbox-vdi|x-virtualbox-vhd|x-virtualbox-vmdk|x-www-form-urlencoded)|font\/(?:otf|ttf)|image\/(?:bmp|vnd\.adobe\.photoshop|vnd\.microsoft\.icon|vnd\.ms-dds|x-icon|x-ms-bmp)|message\/rfc822|model\/gltf-binary|x-shader\/x-fragment|x-shader\/x-vertex|[^;\s]+?\+(?:json|text|xml|yaml))(?:[;\s]|$)/i;
var ENCODINGS = {
	br: ".br",
	zstd: ".zst",
	gzip: ".gz"
};
var ENCODINGS_ORDERED_KEYS = Object.keys(ENCODINGS);
var getStats = (path) => {
	let stats;
	try {
		stats = statSync(path);
	} catch {}
	return stats;
};
var BYTE_RANGE_PATTERN = /^(?:bytes=)?(?!-$)(\d*)-(\d*)$/;
var parseByteRange = (range) => {
	const match = range.match(BYTE_RANGE_PATTERN);
	if (!match) return;
	const [, start, end] = match;
	if (start === "") return {
		type: "suffix",
		length: Number(end)
	};
	if (end === "") return {
		type: "open-ended",
		start: Number(start)
	};
	return {
		type: "bounded",
		start: Number(start),
		end: Number(end)
	};
};
var resolveByteRange = (spec, size) => {
	if (size === 0) return;
	if (spec.type === "suffix") {
		if (spec.length === 0) return;
		return {
			start: Math.max(size - spec.length, 0),
			end: size - 1
		};
	}
	const end = spec.type === "bounded" ? Math.min(spec.end, size - 1) : size - 1;
	if (spec.start >= size || spec.start > end) return;
	return {
		start: spec.start,
		end
	};
};
var tryDecode$1 = (str, decoder) => {
	try {
		return decoder(str);
	} catch {
		return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
			try {
				return decoder(match);
			} catch {
				return match;
			}
		});
	}
};
var tryDecodeURI = (str) => tryDecode$1(str, decodeURI);
var serveStatic = (options = { root: "" }) => {
	const root = options.root || "";
	const optionPath = options.path;
	if (root !== "" && !existsSync(root)) console.error(`serveStatic: root path '${root}' is not found, are you sure it's correct?`);
	return async (c, next) => {
		if (c.finalized) return next();
		if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
		let filename;
		if (optionPath) filename = optionPath;
		else try {
			filename = tryDecodeURI(c.req.path);
			if (c.req.path.includes("%") && (!options.allowPercentInPath || filename !== c.req.path.replace(/%25/g, "%"))) throw new Error();
			if (/(?:^|[\/\\])\.{1,2}(?:$|[\/\\])|[\/\\]{2,}|\\/.test(filename)) throw new Error();
		} catch {
			await options.onNotFound?.(c.req.path, c);
			return next();
		}
		let path = join(root, !optionPath && options.rewriteRequestPath ? options.rewriteRequestPath(filename, c) : filename);
		let stats = getStats(path);
		if (stats && stats.isDirectory()) {
			const indexFile = options.index ?? "index.html";
			path = join(path, indexFile);
			stats = getStats(path);
		}
		if (!stats) {
			await options.onNotFound?.(path, c);
			return next();
		}
		const mimeType = getMimeType(path);
		c.header("Content-Type", mimeType || "application/octet-stream");
		if (options.precompressed && (!mimeType || mimeType === "application/octet-stream" || COMPRESSIBLE_CONTENT_TYPE_REGEX$1.test(mimeType))) {
			const acceptEncodingSet = new Set(c.req.header("Accept-Encoding")?.split(",").map((encoding) => encoding.trim()));
			for (const encoding of ENCODINGS_ORDERED_KEYS) {
				if (!acceptEncodingSet.has(encoding)) continue;
				const precompressedStats = getStats(path + ENCODINGS[encoding]);
				if (precompressedStats) {
					c.header("Content-Encoding", encoding);
					c.header("Vary", "Accept-Encoding", { append: true });
					stats = precompressedStats;
					path = path + ENCODINGS[encoding];
					break;
				}
			}
		}
		let result;
		const size = stats.size;
		const range = c.req.header("range") || "";
		c.header("Last-Modified", stats.mtime.toUTCString());
		if (c.req.method === "HEAD") {
			c.header("Content-Length", size.toString());
			c.status(200);
			result = c.body(null);
		} else if (!range) {
			c.header("Content-Length", size.toString());
			result = c.body(createStreamBody(createReadStream(path)), 200);
		} else {
			c.header("Accept-Ranges", "bytes");
			const resolvedRange = resolveByteRange(parseByteRange(range) ?? {
				type: "open-ended",
				start: 0
			}, size);
			if (!resolvedRange) {
				c.header("Content-Range", `bytes */${size}`);
				result = c.body(null, 416);
			} else {
				const { start, end } = resolvedRange;
				const chunkSize = end - start + 1;
				const stream = createReadStream(path, {
					start,
					end
				});
				c.header("Content-Length", chunkSize.toString());
				c.header("Content-Range", `bytes ${start}-${end}/${size}`);
				result = c.body(createStreamBody(stream), 206);
			}
		}
		await options.onFound?.(path, c);
		return result;
	};
};
// node_modules/hono/dist/http-exception.js
/**
* `HTTPException` must be used when a fatal error such as authentication failure occurs.
*
* @see {@link https://hono.dev/docs/api/exception}
*
* @param {StatusCode} status - status code of HTTPException
* @param {HTTPExceptionOptions} options - options of HTTPException
* @param {HTTPExceptionOptions["res"]} options.res - response of options of HTTPException
* @param {HTTPExceptionOptions["message"]} options.message - message of options of HTTPException
* @param {HTTPExceptionOptions["cause"]} options.cause - cause of options of HTTPException
*
* @example
* ```ts
* import { HTTPException } from 'hono/http-exception'
*
* // ...
*
* app.post('/auth', async (c, next) => {
*   // authentication
*   if (authorized === false) {
*     throw new HTTPException(401, { message: 'Custom error message' })
*   }
*   await next()
* })
* ```
*/
var HTTPException = class extends Error {
	res;
	status;
	/**
	* Creates an instance of `HTTPException`.
	* @param status - HTTP status code for the exception. Defaults to 500.
	* @param options - Additional options for the exception.
	*/
	constructor(status = 500, options) {
		super(options?.message, { cause: options?.cause });
		this.res = options?.res;
		this.status = status;
	}
	/**
	* Returns the response object associated with the exception.
	* If a response object is not provided, a new response is created with the error message and status code.
	* @returns The response object.
	*/
	getResponse() {
		if (this.res) return new Response(this.res.body, {
			status: this.status,
			headers: this.res.headers
		});
		return new Response(this.message, { status: this.status });
	}
};
// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = Symbol();
// node_modules/hono/dist/utils/buffer.js
var bufferToFormData = (arrayBuffer, contentType) => {
	return new Response(arrayBuffer, { headers: { "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase()) } }).formData();
};
// node_modules/hono/dist/utils/body.js
var MAX_NESTED_OBJECTS = 1e4;
var isRawRequest = (request) => "headers" in request;
var parseBody = async (request, options = Object.create(null)) => {
	const { all = false, dot = false } = options;
	const mediaType = (isRawRequest(request) ? request.headers : request.raw.headers).get("Content-Type")?.split(";")[0].trim().toLowerCase();
	if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") return parseFormData(request, {
		all,
		dot
	});
	return {};
};
/**
* Parses form data from a request.
*
* @template T - The type of the parsed body data.
* @param {HonoRequest | Request} request - The request object containing form data.
* @param {ParseBodyOptions} options - Options for parsing the form data.
* @returns {Promise<T>} The parsed body data.
*/
async function parseFormData(request, options) {
	if (!isRawRequest(request) && request.bodyCache.formData) return convertFormDataToBodyData(await request.bodyCache.formData, options);
	const headers = isRawRequest(request) ? request.headers : request.raw.headers;
	const formDataPromise = bufferToFormData(await request.arrayBuffer(), headers.get("Content-Type") || "");
	if (!isRawRequest(request)) request.bodyCache.formData = formDataPromise;
	const formData = await formDataPromise;
	if (formData) return convertFormDataToBodyData(formData, options);
	return {};
}
/**
* Converts form data to body data based on the provided options.
*
* @template T - The type of the parsed body data.
* @param {FormData} formData - The form data to convert.
* @param {ParseBodyOptions} options - Options for parsing the form data.
* @returns {T} The converted body data.
*/
function convertFormDataToBodyData(formData, options) {
	const form = Object.create(null);
	const nestingState = { count: 0 };
	formData.forEach((value, key) => {
		if (!(options.all || key.endsWith("[]"))) form[key] = value;
		else handleParsingAllValues(form, key, value);
	});
	if (options.dot) Object.entries(form).forEach(([key, value]) => {
		if (key.includes(".")) {
			handleParsingNestedValues(form, key, value, nestingState);
			delete form[key];
		}
	});
	return form;
}
/**
* Handles parsing all values for a given key, supporting multiple values as arrays.
*
* @param {BodyData} form - The form data object.
* @param {string} key - The key to parse.
* @param {FormDataEntryValue} value - The value to assign.
*/
var handleParsingAllValues = (form, key, value) => {
	if (form[key] !== void 0) {
		if (Array.isArray(form[key])) form[key].push(value);
		else form[key] = [form[key], value];
	} else if (!key.endsWith("[]")) form[key] = value;
	else form[key] = [value];
};
/**
* Handles parsing nested values using dot notation keys.
*
* @param {BodyData} form - The form data object.
* @param {string} key - The dot notation key.
* @param {BodyDataValue} value - The value to assign.
* @param {{ count: number }} state - The state object tracking nesting depth.
*/
var handleParsingNestedValues = (form, key, value, state) => {
	if (/(?:^|\.)__proto__\./.test(key)) return;
	let nestedForm = form;
	const keys = key.split(".", 34);
	if (keys.length > 33) throwNestingLimitExceeded();
	keys.forEach((key, index) => {
		if (index === keys.length - 1) nestedForm[key] = value;
		else {
			if (!nestedForm[key] || typeof nestedForm[key] !== "object" || Array.isArray(nestedForm[key]) || nestedForm[key] instanceof File) {
				if (state.count++ >= MAX_NESTED_OBJECTS) throwNestingLimitExceeded();
				nestedForm[key] = Object.create(null);
			}
			nestedForm = nestedForm[key];
		}
	});
};
var throwNestingLimitExceeded = () => {
	throw new Error("Nesting limit exceeded");
};
// node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
	const paths = path.split("/");
	if (paths[0] === "") paths.shift();
	return paths;
};
var splitRoutingPath = (routePath) => {
	const { groups, path } = extractGroupsFromPath(routePath);
	return replaceGroupMarks(splitPath(path), groups);
};
var extractGroupsFromPath = (path) => {
	const groups = [];
	path = path.replace(/\{[^}]+\}/g, (match, index) => {
		const mark = `@${index}`;
		groups.push([mark, match]);
		return mark;
	});
	return {
		groups,
		path
	};
};
var replaceGroupMarks = (paths, groups) => {
	for (let i = groups.length - 1; i >= 0; i--) {
		const [mark] = groups[i];
		for (let j = paths.length - 1; j >= 0; j--) if (paths[j].includes(mark)) {
			paths[j] = paths[j].replace(mark, groups[i][1]);
			break;
		}
	}
	return paths;
};
var patternCache = {};
var getPattern = (label, next) => {
	if (label === "*") return "*";
	const match = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
	if (match) {
		const cacheKey = `${label}#${next}`;
		if (!patternCache[cacheKey]) {
			if (match[2]) patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [
				cacheKey,
				match[1],
				new RegExp(`^${match[2]}(?=/${next})`)
			] : [
				label,
				match[1],
				new RegExp(`^${match[2]}$`)
			];
			else patternCache[cacheKey] = [
				label,
				match[1],
				true
			];
		}
		return patternCache[cacheKey];
	}
	return null;
};
var tryDecode = (str, decoder) => {
	try {
		return decoder(str);
	} catch {
		return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
			try {
				return decoder(match);
			} catch {
				return match;
			}
		});
	}
};
var decodeURIWithPreservedPercent = (value) => decodeURI(value.includes("%25") ? value.replace(/%25/g, "%2525") : value);
var getPath = (request) => {
	const url = request.url;
	const start = url.indexOf("/", url.indexOf(":") + 4);
	let i = start;
	for (; i < url.length; i++) {
		const charCode = url.charCodeAt(i);
		if (charCode === 37) {
			const queryIndex = url.indexOf("?", i);
			const hashIndex = url.indexOf("#", i);
			const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
			const path = url.slice(start, end);
			const decoded = tryDecode(path, decodeURIWithPreservedPercent);
			if (/%(?![0-9A-Fa-f]{2})/.test(path)) {
				const rewritten = new URL("http://localhost");
				rewritten.pathname = decoded.replace(/[\\\t\n\r]/g, encodeURIComponent);
				if (tryDecode(rewritten.pathname, decodeURIWithPreservedPercent) !== decoded) return tryDecode(path.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"), decodeURIWithPreservedPercent);
			}
			return decoded;
		} else if (charCode === 63 || charCode === 35) break;
	}
	return url.slice(start, i);
};
var getPathNoStrict = (request) => {
	const result = getPath(request);
	return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
/**
* Merge paths.
* @param {string[]} ...paths - The paths to merge.
* @returns {string} The merged path.
* @example
* mergePath('/api', '/users') // '/api/users'
* mergePath('/api/', '/users') // '/api/users'
* mergePath('/api', '/') // '/api'
* mergePath('/api/', '/') // '/api/'
*/
var mergePath = (base, sub, ...rest) => {
	if (rest.length) sub = mergePath(sub, ...rest);
	return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
var checkOptionalParameter = (path) => {
	if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) return null;
	const segments = path.split("/");
	const results = [];
	let basePath = "";
	segments.forEach((segment) => {
		if (segment !== "" && !/\:/.test(segment)) basePath += "/" + segment;
		else if (/\:/.test(segment)) {
			if (segment.charCodeAt(segment.length - 1) === 63) {
				if (results.length === 0 && basePath === "") results.push("/");
				else results.push(basePath);
				const optionalSegment = segment.slice(0, -1);
				basePath += "/" + optionalSegment;
				results.push(basePath);
			} else basePath += "/" + segment;
		}
	});
	return results.filter((v, i, a) => a.indexOf(v) === i);
};
var tryDecodeURIComponent = (str) => str.indexOf("%") !== -1 ? tryDecode(str, decodeURIComponent_) : str;
var _decodeURI = (value) => {
	if (value.indexOf("+") !== -1) value = value.replace(/\+/g, " ");
	return tryDecodeURIComponent(value);
};
var _getQueryParam = (url, key, multiple) => {
	const hashIndex = url.indexOf("#", 8);
	if (hashIndex !== -1) url = url.slice(0, hashIndex);
	let encoded;
	if (!multiple && key && !/[%+&=]/.test(key)) {
		const queryIndex = url.indexOf("?", 8);
		let keyIndex = queryIndex;
		if (keyIndex === -1) return;
		if (!url.startsWith(key, keyIndex + 1)) keyIndex = url.indexOf(`&${key}`, keyIndex + 1);
		while (keyIndex !== -1) {
			const trailingKeyCode = url.charCodeAt(keyIndex + key.length + 1);
			if (trailingKeyCode === 61 || trailingKeyCode === 38 || isNaN(trailingKeyCode)) {
				if (keyIndex > queryIndex && /(?:^|&)[^=&]*[%+]/.test(url.slice(queryIndex + 1, keyIndex))) break;
				if (trailingKeyCode === 61) {
					const valueIndex = keyIndex + key.length + 2;
					const endIndex = url.indexOf("&", valueIndex);
					return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
				}
				return "";
			}
			keyIndex = url.indexOf(`&${key}`, keyIndex + 1);
		}
		encoded = /[%+]/.test(url);
		if (!encoded) return;
	}
	const results = Object.create(null);
	encoded ??= /[%+]/.test(url);
	let keyIndex = url.indexOf("?", 8);
	while (keyIndex !== -1) {
		const nextKeyIndex = url.indexOf("&", keyIndex + 1);
		let valueIndex = url.indexOf("=", keyIndex);
		if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) valueIndex = -1;
		let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex);
		if (encoded) name = _decodeURI(name);
		keyIndex = nextKeyIndex;
		if (name === "") continue;
		let value;
		if (valueIndex === -1) value = "";
		else {
			value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
			if (encoded) value = _decodeURI(value);
		}
		if (multiple) {
			if (!(results[name] && Array.isArray(results[name]))) results[name] = [];
			results[name].push(value);
		} else results[name] ??= value;
	}
	return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
	return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;
// node_modules/hono/dist/request.js
var HonoRequest = class {
	/**
	* `.raw` can get the raw Request object.
	*
	* @see {@link https://hono.dev/docs/api/request#raw}
	*
	* @example
	* ```ts
	* // For Cloudflare Workers
	* app.post('/', async (c) => {
	*   const metadata = c.req.raw.cf?.hostMetadata?
	*   ...
	* })
	* ```
	*/
	raw;
	#validatedData;
	#matchResult;
	routeIndex = 0;
	/**
	* `.path` can get the pathname of the request.
	*
	* @see {@link https://hono.dev/docs/api/request#path}
	*
	* @example
	* ```ts
	* app.get('/about/me', (c) => {
	*   const pathname = c.req.path // `/about/me`
	* })
	* ```
	*/
	path;
	bodyCache = {};
	constructor(request, path = "/", matchResult = [[]]) {
		this.raw = request;
		this.path = path;
		this.#matchResult = matchResult;
	}
	param(key) {
		return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
	}
	#getDecodedParam(key) {
		const paramKey = this.#matchResult[0][this.routeIndex]?.[1][key];
		const param = this.#getParamValue(paramKey);
		return param && tryDecodeURIComponent(param);
	}
	#getAllDecodedParams() {
		const decoded = {};
		const keys = Object.keys(this.#matchResult[0][this.routeIndex]?.[1] ?? {});
		for (const key of keys) {
			const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
			if (value !== void 0) decoded[key] = tryDecodeURIComponent(value);
		}
		return decoded;
	}
	#getParamValue(paramKey) {
		return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
	}
	query(key) {
		return getQueryParam(this.url, key);
	}
	queries(key) {
		return getQueryParams(this.url, key);
	}
	header(name) {
		if (name) return this.raw.headers.get(name) ?? void 0;
		const headerData = Object.create(null);
		this.raw.headers.forEach((value, key) => {
			headerData[key] = value;
		});
		return headerData;
	}
	async parseBody(options) {
		return parseBody(this, options);
	}
	#cachedBody = (key) => {
		const { bodyCache, raw } = this;
		const cachedBody = bodyCache[key];
		if (cachedBody) return cachedBody;
		for (const anyCachedKey in bodyCache) return bodyCache[anyCachedKey].then((body) => {
			if (anyCachedKey === "json") body = JSON.stringify(body);
			const contentType = anyCachedKey === "formData" ? void 0 : raw.headers.get("content-type");
			return new Response(body, { headers: contentType ? { "Content-Type": contentType } : void 0 })[key]();
		});
		return bodyCache[key] = raw[key]();
	};
	/**
	* `.json()` can parse Request body of type `application/json`
	*
	* @see {@link https://hono.dev/docs/api/request#json}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.json()
	* })
	* ```
	*/
	json() {
		return this.#cachedBody("text").then((text) => JSON.parse(text));
	}
	/**
	* `.text()` can parse Request body of type `text/plain`
	*
	* @see {@link https://hono.dev/docs/api/request#text}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.text()
	* })
	* ```
	*/
	text() {
		return this.#cachedBody("text");
	}
	/**
	* `.arrayBuffer()` parse Request body as an `ArrayBuffer`
	*
	* @see {@link https://hono.dev/docs/api/request#arraybuffer}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.arrayBuffer()
	* })
	* ```
	*/
	arrayBuffer() {
		return this.#cachedBody("arrayBuffer");
	}
	/**
	* `.bytes()` parses the request body as a `Uint8Array`.
	*
	* @see {@link https://hono.dev/docs/api/request#bytes}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.bytes()
	* })
	* ```
	*/
	bytes() {
		return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
	}
	/**
	* Parses the request body as a `Blob`.
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.blob();
	* });
	* ```
	* @see https://hono.dev/docs/api/request#blob
	*/
	blob() {
		return this.#cachedBody("blob");
	}
	/**
	* Parses the request body as `FormData`.
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.formData();
	* });
	* ```
	* @see https://hono.dev/docs/api/request#formdata
	*/
	formData() {
		return this.#cachedBody("formData");
	}
	/**
	* Adds validated data to the request.
	*
	* @param target - The target of the validation.
	* @param data - The validated data to add.
	*/
	addValidatedData(target, data) {
		(this.#validatedData ??= {})[target] = data;
	}
	valid(target) {
		return this.#validatedData?.[target];
	}
	/**
	* `.url` can get the request url strings.
	*
	* @see {@link https://hono.dev/docs/api/request#url}
	*
	* @example
	* ```ts
	* app.get('/about/me', (c) => {
	*   const url = c.req.url // `http://localhost:8787/about/me`
	*   ...
	* })
	* ```
	*/
	get url() {
		return this.raw.url;
	}
	/**
	* `.method` can get the method name of the request.
	*
	* @see {@link https://hono.dev/docs/api/request#method}
	*
	* @example
	* ```ts
	* app.get('/about/me', (c) => {
	*   const method = c.req.method // `GET`
	* })
	* ```
	*/
	get method() {
		return this.raw.method;
	}
	get [GET_MATCH_RESULT]() {
		return this.#matchResult;
	}
	/**
	* `.matchedRoutes` can return a matched route in the handler
	*
	* @deprecated
	*
	* Use matchedRoutes helper defined in "hono/route" instead.
	*
	* @see {@link https://hono.dev/docs/api/request#matchedroutes}
	*
	* @example
	* ```ts
	* app.use('*', async function logger(c, next) {
	*   await next()
	*   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
	*     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
	*     console.log(
	*       method,
	*       ' ',
	*       path,
	*       ' '.repeat(Math.max(10 - path.length, 0)),
	*       name,
	*       i === c.req.routeIndex ? '<- respond from here' : ''
	*     )
	*   })
	* })
	* ```
	*/
	get matchedRoutes() {
		return this.#matchResult[0].map(([[, route]]) => route);
	}
	/**
	* `.routePath` can retrieve the path registered within the handler
	*
	* @deprecated
	*
	* Use routePath helper defined in "hono/route" instead.
	*
	* @see {@link https://hono.dev/docs/api/request#routepath}
	*
	* @example
	* ```ts
	* app.get('/posts/:id', (c) => {
	*   return c.json({ path: c.req.routePath })
	* })
	* ```
	*/
	get routePath() {
		return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
	}
};
// node_modules/hono/dist/utils/html.js
/**
* @module
* HTML utility.
*/
var HtmlEscapedCallbackPhase = {
	Stringify: 1,
	BeforeStream: 2,
	Stream: 3
};
var raw = (value, callbacks) => {
	const escapedString = new String(value);
	escapedString.isEscaped = true;
	escapedString.callbacks = callbacks;
	return escapedString;
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
	if (typeof str === "object" && !(str instanceof String)) {
		if (!(str instanceof Promise)) str = str.toString();
		if (str instanceof Promise) str = await str;
	}
	const callbacks = str.callbacks;
	if (!callbacks?.length) return Promise.resolve(str);
	if (buffer) buffer[0] += str;
	else buffer = [str];
	const resStr = Promise.all(callbacks.map((c) => c({
		phase,
		buffer,
		context
	}))).then((res) => Promise.all(res.filter(Boolean).map((str) => resolveCallback(str, phase, false, context, buffer))).then(() => buffer[0]));
	if (preserveCallbacks) return raw(await resStr, callbacks);
	else return resStr;
};
// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = (contentType, headers) => {
	return {
		"Content-Type": contentType,
		...headers
	};
};
var createResponseInstance = (body, init) => new Response(body, init);
var Context = class {
	#rawRequest;
	#req;
	/**
	* `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
	*
	* @see {@link https://hono.dev/docs/api/context#env}
	*
	* @example
	* ```ts
	* // Environment object for Cloudflare Workers
	* app.get('*', async c => {
	*   const counter = c.env.COUNTER
	* })
	* ```
	*/
	env = {};
	#var;
	finalized = false;
	/**
	* `.error` can get the error object from the middleware if the Handler throws an error.
	*
	* @see {@link https://hono.dev/docs/api/context#error}
	*
	* @example
	* ```ts
	* app.use('*', async (c, next) => {
	*   await next()
	*   if (c.error) {
	*     // do something...
	*   }
	* })
	* ```
	*/
	error;
	#status;
	#executionCtx;
	#res;
	#layout;
	#renderer;
	#notFoundHandler;
	#preparedHeaders;
	#matchResult;
	#path;
	/**
	* Creates an instance of the Context class.
	*
	* @param req - The Request object.
	* @param options - Optional configuration options for the context.
	*/
	constructor(req, options) {
		this.#rawRequest = req;
		if (options) {
			this.#executionCtx = options.executionCtx;
			this.env = options.env;
			this.#notFoundHandler = options.notFoundHandler;
			this.#path = options.path;
			this.#matchResult = options.matchResult;
		}
	}
	/**
	* `.req` is the instance of {@link HonoRequest}.
	*/
	get req() {
		this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
		return this.#req;
	}
	/**
	* @see {@link https://hono.dev/docs/api/context#event}
	* The FetchEvent associated with the current request.
	*
	* @throws Will throw an error if the context does not have a FetchEvent.
	*/
	get event() {
		if (this.#executionCtx && "respondWith" in this.#executionCtx) return this.#executionCtx;
		else throw Error("This context has no FetchEvent");
	}
	/**
	* @see {@link https://hono.dev/docs/api/context#executionctx}
	* The ExecutionContext associated with the current request.
	*
	* @throws Will throw an error if the context does not have an ExecutionContext.
	*/
	get executionCtx() {
		if (this.#executionCtx) return this.#executionCtx;
		else throw Error("This context has no ExecutionContext");
	}
	/**
	* @see {@link https://hono.dev/docs/api/context#res}
	* The Response object for the current request.
	*/
	get res() {
		return this.#res ||= createResponseInstance(null, { headers: this.#preparedHeaders ??= new Headers() });
	}
	/**
	* Sets the Response object for the current request.
	*
	* @param _res - The Response object to set.
	*/
	set res(_res) {
		if (this.#res && _res) {
			_res = createResponseInstance(_res.body, _res);
			for (const [k, v] of this.#res.headers.entries()) {
				if (k === "content-type") continue;
				if (k === "set-cookie") {
					const cookies = this.#res.headers.getSetCookie();
					_res.headers.delete("set-cookie");
					for (const cookie of cookies) _res.headers.append("set-cookie", cookie);
				} else _res.headers.set(k, v);
			}
		}
		this.#res = _res;
		this.finalized = true;
	}
	/**
	* `.render()` can create a response within a layout.
	*
	* @see {@link https://hono.dev/docs/api/context#render-setrenderer}
	*
	* @example
	* ```ts
	* app.get('/', (c) => {
	*   return c.render('Hello!')
	* })
	* ```
	*/
	render = (...args) => {
		this.#renderer ??= (content) => this.html(content);
		return this.#renderer(...args);
	};
	/**
	* Sets the layout for the response.
	*
	* @param layout - The layout to set.
	* @returns The layout function.
	*/
	setLayout = (layout) => this.#layout = layout;
	/**
	* Gets the current layout for the response.
	*
	* @returns The current layout function.
	*/
	getLayout = () => this.#layout;
	/**
	* `.setRenderer()` can set the layout in the custom middleware.
	*
	* @see {@link https://hono.dev/docs/api/context#render-setrenderer}
	*
	* @example
	* ```tsx
	* app.use('*', async (c, next) => {
	*   c.setRenderer((content) => {
	*     return c.html(
	*       <html>
	*         <body>
	*           <p>{content}</p>
	*         </body>
	*       </html>
	*     )
	*   })
	*   await next()
	* })
	* ```
	*/
	setRenderer = (renderer) => {
		this.#renderer = renderer;
	};
	/**
	* `.header()` can set headers.
	*
	* @see {@link https://hono.dev/docs/api/context#header}
	*
	* @example
	* ```ts
	* app.get('/welcome', (c) => {
	*   // Set headers
	*   c.header('X-Message', 'Hello!')
	*   c.header('Content-Type', 'text/plain')
	*
	*   // Append multiple headers using the append option (e.g. Vary)
	*   c.header('Vary', 'Accept-Encoding', { append: true })
	*   c.header('Vary', 'User-Agent', { append: true })
	*
	*   return c.body('Thank you for coming')
	* })
	* ```
	*/
	header = (name, value, options) => {
		if (this.finalized && !this.#res.bodyUsed) this.#res = createResponseInstance(this.#res.body, this.#res);
		const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
		if (value === void 0) headers.delete(name);
		else if (options?.append) headers.append(name, value);
		else headers.set(name, value);
	};
	status = (status) => {
		this.#status = status;
	};
	/**
	* `.set()` can set the value specified by the key.
	*
	* @see {@link https://hono.dev/docs/api/context#set-get}
	*
	* @example
	* ```ts
	* app.use('*', async (c, next) => {
	*   c.set('message', 'Hono is hot!!')
	*   await next()
	* })
	* ```
	*/
	set = (key, value) => {
		this.#var ??= /* @__PURE__ */ new Map();
		this.#var.set(key, value);
	};
	/**
	* `.get()` can use the value specified by the key.
	*
	* @see {@link https://hono.dev/docs/api/context#set-get}
	*
	* @example
	* ```ts
	* app.get('/', (c) => {
	*   const message = c.get('message')
	*   return c.text(`The message is "${message}"`)
	* })
	* ```
	*/
	get = (key) => {
		return this.#var ? this.#var.get(key) : void 0;
	};
	/**
	* `.var` can access the value of a variable.
	*
	* @see {@link https://hono.dev/docs/api/context#var}
	*
	* @example
	* ```ts
	* const result = c.var.client.oneMethod()
	* ```
	*/
	get var() {
		if (!this.#var) return {};
		return Object.fromEntries(this.#var);
	}
	#newResponse(data, arg, headers) {
		let responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders;
		if (typeof arg === "object" && arg.headers) {
			responseHeaders ??= new Headers();
			for (const [key, value] of new Headers(arg.headers)) if (key === "set-cookie") responseHeaders.append(key, value);
			else responseHeaders.set(key, value);
		}
		if (headers) {
			if (!responseHeaders) {
				let count = 0;
				for (const k in headers) if (++count > 1 || typeof headers[k] !== "string") {
					responseHeaders = new Headers();
					break;
				}
			}
			if (responseHeaders) for (const k in headers) {
				const v = headers[k];
				if (typeof v === "string") responseHeaders.set(k, v);
				else {
					responseHeaders.delete(k);
					for (const v2 of v) responseHeaders.append(k, v2);
				}
			}
		}
		return createResponseInstance(data, {
			status: typeof arg === "number" ? arg : arg?.status ?? this.#status,
			headers: responseHeaders ?? headers
		});
	}
	newResponse = (...args) => this.#newResponse(...args);
	/**
	* `.body()` can return the HTTP response.
	* You can set headers with `.header()` and set HTTP status code with `.status`.
	* This can also be set in `.text()`, `.json()` and so on.
	*
	* @see {@link https://hono.dev/docs/api/context#body}
	*
	* @example
	* ```ts
	* app.get('/welcome', (c) => {
	*   // Set headers
	*   c.header('X-Message', 'Hello!')
	*   c.header('Content-Type', 'text/plain')
	*   // Set HTTP status code
	*   c.status(201)
	*
	*   // Return the response body
	*   return c.body('Thank you for coming')
	* })
	* ```
	*/
	body = (data, arg, headers) => this.#newResponse(data, arg, headers);
	/**
	* `.text()` can render text as `Content-Type:text/plain`.
	*
	* @see {@link https://hono.dev/docs/api/context#text}
	*
	* @example
	* ```ts
	* app.get('/say', (c) => {
	*   return c.text('Hello!')
	* })
	* ```
	*/
	text = (text, arg, headers) => {
		return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
	};
	/**
	* `.json()` can render JSON as `Content-Type:application/json`.
	*
	* @see {@link https://hono.dev/docs/api/context#json}
	*
	* @example
	* ```ts
	* app.get('/api', (c) => {
	*   return c.json({ message: 'Hello!' })
	* })
	* ```
	*/
	json = (object, arg, headers) => {
		return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType("application/json", headers));
	};
	html = (html, arg, headers) => {
		const res = (html) => this.#newResponse(html, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
		return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
	};
	/**
	* `.redirect()` can Redirect, default status code is 302.
	*
	* @see {@link https://hono.dev/docs/api/context#redirect}
	*
	* @example
	* ```ts
	* app.get('/redirect', (c) => {
	*   return c.redirect('/')
	* })
	* app.get('/redirect-permanently', (c) => {
	*   return c.redirect('/', 301)
	* })
	* ```
	*/
	redirect = (location, status) => {
		const locationString = String(location);
		this.header("Location", !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
		return this.newResponse(null, status ?? 302);
	};
	/**
	* `.notFound()` can return the Not Found Response.
	*
	* @see {@link https://hono.dev/docs/api/context#notfound}
	*
	* @example
	* ```ts
	* app.get('/notfound', (c) => {
	*   return c.notFound()
	* })
	* ```
	*/
	notFound = () => {
		this.#notFoundHandler ??= () => createResponseInstance();
		return this.#notFoundHandler(this);
	};
};
// node_modules/hono/dist/compose.js
/**
* Compose middleware functions into a single function based on `koa-compose` package.
*
* @template E - The environment type.
*
* @param {[[Function, unknown], unknown][] | [[Function]][]} middleware - An array of middleware functions and their corresponding parameters.
* @param {ErrorHandler<E>} [onError] - An optional error handler function.
* @param {NotFoundHandler<E>} [onNotFound] - An optional not-found handler function.
*
* @returns {(context: Context, next?: Next) => Promise<Context>} - A composed middleware function.
*/
var compose = (middleware, onError, onNotFound) => {
	return (context, next) => {
		let index = -1;
		return dispatch(0);
		/**
		* Dispatch the middleware functions.
		*
		* @param {number} i - The current index in the middleware array.
		*
		* @returns {Promise<Context>} - A promise that resolves to the context.
		*/
		async function dispatch(i) {
			if (i <= index) throw new Error("next() called multiple times");
			index = i;
			let res;
			let isError = false;
			let handler;
			if (middleware[i]) {
				handler = middleware[i][0][0];
				context.req.routeIndex = i;
			} else handler = i === middleware.length && next || void 0;
			if (handler) try {
				res = await handler(context, () => dispatch(i + 1));
			} catch (err) {
				if (err instanceof Error && onError) {
					context.error = err;
					res = await onError(err, context);
					isError = true;
				} else throw err;
			}
			else if (context.finalized === false && onNotFound) res = await onNotFound(context);
			if (res && (context.finalized === false || isError)) context.res = res;
			return context;
		}
	};
};
// node_modules/hono/dist/helper/route/index.js
/**
* Get matched routes in the handler
*
* @param {Context} c - The context object
* @returns An array of matched routes
*
* @example
* ```ts
* import { matchedRoutes } from 'hono/route'
*
* app.use('*', async function logger(c, next) {
*   await next()
*   matchedRoutes(c).forEach(({ handler, method, path }, i) => {
*     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
*     console.log(
*       method,
*       ' ',
*       path,
*       ' '.repeat(Math.max(10 - path.length, 0)),
*       name,
*       i === c.req.routeIndex ? '<- respond from here' : ''
*     )
*   })
* })
* ```
*/
var matchedRoutes = (c) => c.req[GET_MATCH_RESULT][0].map(([[, route]]) => route);
/**
* Get the route path registered within the handler
*
* @param {Context} c - The context object
* @param {number} index - The index of the route from which to retrieve the path, similar to Array.prototype.at(), where a negative number is the index counted from the end of the matching route. Defaults to the current route index.
* @returns The route path registered within the handler
*
* @example
* ```ts
* import { routePath } from 'hono/route'
*
* app.use('*', (c, next) => {
*   console.log(routePath(c)) // '*'
*   console.log(routePath(c, -1)) // '/posts/:id'
*   return next()
* })
*
* app.get('/posts/:id', (c) => {
*   return c.text(routePath(c)) // '/posts/:id'
* })
* ```
*/
var routePath = (c, index) => matchedRoutes(c).at(index ?? c.req.routeIndex)?.path ?? "";
// node_modules/hono/dist/router.js
/**
* Array of supported HTTP methods.
*/
var METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"options",
	"patch",
	"query"
];
/**
* Error message indicating that a route cannot be added because the matcher is already built.
*/
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
/**
* Error class representing an unsupported path error.
*/
var UnsupportedPathError = class extends Error {};
// node_modules/hono/dist/utils/constants.js
/**
* Constant used to mark a composed handler.
*/
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";
// node_modules/hono/dist/utils/mount.js
var countTrailingSlashes = (path) => {
	let index = path.length;
	while (index > 0 && path.charCodeAt(index - 1) === 47) index--;
	return path.length - index;
};
var getPathPrefixLength = (c, pathPrefix, routePath) => {
	if (!/[:*]/.test(pathPrefix)) return pathPrefix.length;
	const path = c.req.path;
	const matchResult = c.req[GET_MATCH_RESULT];
	const paramNames = /* @__PURE__ */ new Set();
	let length = 0;
	for (const part of splitRoutingPath(pathPrefix)) {
		if (part[0] === ":" && part.endsWith("}?")) throw new Error(`mount(): Optional regular expression parameters are not supported in "${routePath}".`);
		const pattern = getPattern(part);
		if (pattern && pattern !== "*") {
			const name = pattern[1];
			if (paramNames.has(name)) throw new Error(`mount(): Duplicate path parameter "${name}" in "${routePath}".`);
			paramNames.add(name);
		}
		if (pattern && pattern !== "*" && pattern[2] !== true) {
			const value = matchResult.length === 2 ? matchResult[1][matchResult[0][c.req.routeIndex][1][pattern[1]]] : matchResult[0][c.req.routeIndex][1][pattern[1]];
			length += value.length + 1;
		} else if (pattern || part.endsWith("*")) {
			const end = path.indexOf("/", length + 1);
			length = end === -1 ? path.length : end;
		} else length += part.length + 1;
	}
	return length;
};
var createMountedRequest = (c, pathPrefix, routePath) => {
	if (/[^/]\*$/.test(routePath)) throw new Error(`mount(): Wildcard must follow "/" in "${routePath}".`);
	const prefixLength = getPathPrefixLength(c, pathPrefix, routePath);
	const path = c.req.path.slice(prefixLength) || "/";
	if (prefixLength > c.req.path.length || path[0] !== "/" || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(path)) throw new HTTPException(400, { message: "Invalid mounted path" });
	const rawUrl = c.req.raw.url;
	if (/^[^/?#]*\/\/[^/?#\\]*[?#\\]/.test(rawUrl)) throw new HTTPException(400, { message: "Invalid mounted path" });
	const rawPathEnd = rawUrl.search(/[?#]/);
	const rawTrailingSlashes = countTrailingSlashes(rawPathEnd === -1 ? rawUrl : rawUrl.slice(0, rawPathEnd));
	if (rawTrailingSlashes > 1 && countTrailingSlashes(c.req.path) === rawTrailingSlashes - 1) throw new HTTPException(400, { message: "Invalid mounted path" });
	const url = new URL(rawUrl);
	url.pathname = path.replace(/[\\\t\n\r]/g, encodeURIComponent);
	if (path.includes("%")) {}
	return new Request(url, c.req.raw);
};
// node_modules/hono/dist/hono-base.js
/**
* @module
* This module is the base module for the Hono object.
*/
var notFoundHandler = (c) => {
	return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
	if ("getResponse" in err) {
		const res = err.getResponse();
		return c.newResponse(res.body, res);
	}
	console.error(err);
	return c.text("Internal Server Error", 500);
};
var Hono$1 = class Hono {
	get;
	post;
	put;
	delete;
	options;
	patch;
	query;
	all;
	on;
	use;
	router;
	getPath;
	_basePath = "/";
	#path = "/";
	routes = [];
	constructor(options = {}) {
		[...METHODS, "all"].forEach((method) => {
			this[method] = (args1, ...args) => {
				const methodName = method.toUpperCase();
				if (typeof args1 === "string") this.#path = args1;
				else this.#addRoute(methodName, this.#path, args1);
				args.forEach((handler) => {
					this.#addRoute(methodName, this.#path, handler);
				});
				return this;
			};
		});
		this.on = (method, path, ...handlers) => {
			for (const p of [path].flat()) {
				this.#path = p;
				for (const m of [method].flat()) {
					const methodName = m.toUpperCase();
					for (const handler of handlers) this.#addRoute(methodName, this.#path, handler);
				}
			}
			return this;
		};
		this.use = (arg1, ...handlers) => {
			if (typeof arg1 === "string") this.#path = arg1;
			else {
				this.#path = "*";
				handlers.unshift(arg1);
			}
			handlers.forEach((handler) => {
				this.#addRoute("ALL", this.#path, handler);
			});
			return this;
		};
		const { strict, ...optionsWithoutStrict } = options;
		Object.assign(this, optionsWithoutStrict);
		this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
	}
	#clone() {
		const clone = new Hono({
			router: this.router,
			getPath: this.getPath
		});
		clone.errorHandler = this.errorHandler;
		clone.#notFoundHandler = this.#notFoundHandler;
		clone.routes = this.routes;
		return clone;
	}
	#notFoundHandler = notFoundHandler;
	errorHandler = errorHandler;
	/**
	* `.route()` allows grouping other Hono instance in routes.
	*
	* @see {@link https://hono.dev/docs/api/routing#grouping}
	*
	* @param {string} path - base Path
	* @param {Hono} app - other Hono instance
	* @returns {Hono} routed Hono instance
	*
	* @example
	* ```ts
	* const app = new Hono()
	* const app2 = new Hono()
	*
	* app2.get("/user", (c) => c.text("user"))
	* app.route("/api", app2) // GET /api/user
	* ```
	*/
	route(path, app) {
		const subApp = this.basePath(path);
		app.routes.map((r) => {
			let handler;
			if (app.errorHandler === errorHandler) handler = r.handler;
			else {
				handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
				handler[COMPOSED_HANDLER] = r.handler;
			}
			subApp.#addRoute(r.method, r.path, handler, r.basePath);
		});
		return this;
	}
	/**
	* `.basePath()` allows base paths to be specified.
	*
	* @see {@link https://hono.dev/docs/api/routing#base-path}
	*
	* @param {string} path - base Path
	* @returns {Hono} changed Hono instance
	*
	* @example
	* ```ts
	* const api = new Hono().basePath('/api')
	* ```
	*/
	basePath(path) {
		const subApp = this.#clone();
		subApp._basePath = mergePath(this._basePath, path);
		return subApp;
	}
	/**
	* `.onError()` handles an error and returns a customized Response.
	*
	* @see {@link https://hono.dev/docs/api/hono#error-handling}
	*
	* @param {ErrorHandler} handler - request Handler for error
	* @returns {Hono} changed Hono instance
	*
	* @example
	* ```ts
	* app.onError((err, c) => {
	*   console.error(`${err}`)
	*   return c.text('Custom Error Message', 500)
	* })
	* ```
	*/
	onError = (handler) => {
		this.errorHandler = handler;
		return this;
	};
	/**
	* `.notFound()` allows you to customize a Not Found Response.
	*
	* @see {@link https://hono.dev/docs/api/hono#not-found}
	*
	* @param {NotFoundHandler} handler - request handler for not-found
	* @returns {Hono} changed Hono instance
	*
	* @example
	* ```ts
	* app.notFound((c) => {
	*   return c.text('Custom 404 Message', 404)
	* })
	* ```
	*/
	notFound = (handler) => {
		this.#notFoundHandler = handler;
		return this;
	};
	/**
	* `.mount()` allows you to mount applications built with other frameworks into your Hono application.
	*
	* @deprecated Use `mount()` from `hono/mount` instead. `.mount()` will be removed in v5.
	*
	* @see {@link https://hono.dev/docs/api/hono#mount}
	*
	* @param {string} path - base Path
	* @param {Function} applicationHandler - other Request Handler
	* @param {MountOptions} [options] - options of `.mount()`
	* @returns {Hono} mounted Hono instance
	* @throws {Error} If automatic request rewriting encounters duplicate path parameter names or an optional regular expression parameter.
	* @throws {HTTPException} With status 400 if automatic request rewriting cannot safely preserve the routed path.
	*
	* @example
	* ```ts
	* import { Router as IttyRouter } from 'itty-router'
	* import { Hono } from 'hono'
	* // Create itty-router application
	* const ittyRouter = IttyRouter()
	* // GET /itty-router/hello
	* ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
	*
	* const app = new Hono()
	* app.mount('/itty-router', ittyRouter.handle)
	* ```
	*
	* @example
	* ```ts
	* const app = new Hono()
	* // Send the request to another application without modification.
	* app.mount('/app', anotherApp, {
	*   replaceRequest: (req) => req,
	* })
	* ```
	*/
	mount(path, applicationHandler, options) {
		let replaceRequest;
		let optionHandler;
		if (options) {
			if (typeof options === "function") optionHandler = options;
			else {
				optionHandler = options.optionHandler;
				if (options.replaceRequest === false) replaceRequest = (request) => request;
				else replaceRequest = options.replaceRequest;
			}
		}
		const getOptions = optionHandler ? (c) => {
			const options = optionHandler(c);
			return Array.isArray(options) ? options : [options];
		} : (c) => {
			let executionContext = void 0;
			try {
				executionContext = c.executionCtx;
			} catch {}
			return [c.env, executionContext];
		};
		const defaultReplaceRequest = (c) => {
			const mountedRoutePath = routePath(c);
			return createMountedRequest(c, mountedRoutePath.replace(/\/?\*$/, ""), mountedRoutePath);
		};
		const handler = async (c, next) => {
			const res = await applicationHandler(replaceRequest ? replaceRequest(c.req.raw) : defaultReplaceRequest(c), ...getOptions(c));
			if (res) return res;
			await next();
		};
		this.#addRoute("ALL", mergePath(path, "*"), handler);
		return this;
	}
	#addRoute(method, path, handler, baseRoutePath) {
		path = mergePath(this._basePath, path);
		const r = {
			basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
			path,
			method,
			handler
		};
		this.router.add(method, path, [handler, r]);
		this.routes.push(r);
	}
	#handleError(err, c) {
		if (err instanceof Error) return this.errorHandler(err, c);
		throw err;
	}
	#dispatch(request, executionCtx, env, method) {
		if (method === "HEAD") return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
		const path = this.getPath(request, { env });
		const matchResult = this.router.match(method, path);
		const c = new Context(request, {
			path,
			matchResult,
			env,
			executionCtx,
			notFoundHandler: this.#notFoundHandler
		});
		if (matchResult[0].length === 1) {
			let res;
			try {
				res = matchResult[0][0][0][0](c, async () => {
					c.res = await this.#notFoundHandler(c);
				});
			} catch (err) {
				return this.#handleError(err, c);
			}
			return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
		}
		const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
		return (async () => {
			try {
				const context = await composed(c);
				if (!context.finalized) throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
				return context.res;
			} catch (err) {
				return this.#handleError(err, c);
			}
		})();
	}
	/**
	* `.fetch()` will be entry point of your app.
	*
	* @see {@link https://hono.dev/docs/api/hono#fetch}
	*
	* @param {Request} request - request Object of request
	* @param {Env} env - env Object
	* @param {ExecutionContext} executionCtx - context of execution
	* @returns {Response | Promise<Response>} response of request
	*
	*/
	fetch = (request, ...rest) => {
		return this.#dispatch(request, rest[1], rest[0], request.method);
	};
	/**
	* `.request()` is a useful method for testing.
	* You can pass a URL or pathname to send a GET request.
	* app will return a Response object.
	* ```ts
	* test('GET /hello is ok', async () => {
	*   const res = await app.request('/hello')
	*   expect(res.status).toBe(200)
	* })
	* ```
	* @see https://hono.dev/docs/api/hono#request
	*/
	request = (input, requestInit, Env, executionCtx) => {
		if (input instanceof Request) return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
		input = input.toString();
		return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
	};
	/**
	* `.fire()` automatically adds a global fetch event listener.
	* This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
	* @deprecated
	* Use `fire` from `hono/service-worker` instead.
	* ```ts
	* import { Hono } from 'hono'
	* import { fire } from 'hono/service-worker'
	*
	* const app = new Hono()
	* // ...
	* fire(app)
	* ```
	* @see https://hono.dev/docs/api/hono#fire
	* @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
	* @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
	*/
	fire = () => {
		addEventListener("fetch", (event) => {
			event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
		});
	};
};
// node_modules/hono/dist/router/utils.js
var createNullObject = () => Object.create(null);
// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
	const matchers = this.buildAllMatchers();
	const match = ((method, path) => {
		const matcher = matchers[method] || matchers["ALL"];
		const staticMatch = matcher[2][path];
		if (staticMatch) return staticMatch;
		const match = path.match(matcher[0]);
		if (!match) return [[], emptyParam];
		const index = match.indexOf("", 1);
		return [matcher[1][index], match];
	});
	this.match = match;
	return match(method, path);
}
// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = "[^]*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/[^]*)";
var PATH_ERROR = Symbol();
var regExpMetaChars = /* @__PURE__ */ new Set(".\\+*[^]$()");
/**
* Sort order:
* 1. literal
* 2. special pattern (e.g. :label{[0-9]+})
* 3. common label pattern (e.g. :label)
* 4. wildcard
*/
function compareKey(a, b) {
	if (a.length === 1) return b.length === 1 ? a < b ? -1 : 1 : -1;
	if (b.length === 1) return 1;
	if (a === "[^]*" || a === "(?:|/[^]*)") return b === "[^]*" ? -1 : 1;
	else if (b === "[^]*" || b === "(?:|/[^]*)") return -1;
	if (a === "[^/]+") return 1;
	else if (b === "[^/]+") return -1;
	return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node$1 = class Node {
	#index;
	#varIndex;
	#children = createNullObject();
	insert(tokens, index, paramMap, context, keys) {
		let node = this;
		for (let i = 0, len = tokens.length; i < len; i++) {
			const token = tokens[i];
			const pattern = token.length === 1 ? token === "*" ? i === len - 1 ? [
				"",
				"",
				ONLY_WILDCARD_REG_EXP_STR
			] : [
				"",
				"",
				LABEL_REG_EXP_STR
			] : null : token === "/*" ? [
				"",
				"",
				TAIL_WILDCARD_REG_EXP_STR
			] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
			let nextNode;
			if (pattern) {
				const name = pattern[1];
				let regexpStr = pattern[2] || "[^/]+";
				if (name && pattern[2]) {
					if (new RegExp(regexpStr).test("")) throw PATH_ERROR;
					regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
					if (/\((?!\?:)/.test(regexpStr)) throw PATH_ERROR;
					if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) throw PATH_ERROR;
				}
				keys.push(regexpStr);
				nextNode = node.#children[regexpStr];
				if (!nextNode) {
					if (regexpStr !== "[^]*" && regexpStr !== "(?:|/[^]*)") {
						for (const k in node.#children) if ((regexpStr.length > 1 || k.length > 1) && k !== "[^]*" && k !== "(?:|/[^]*)") throw PATH_ERROR;
					}
					nextNode = node.#children[regexpStr] = new Node();
				}
				if (name !== "") {
					nextNode.#varIndex ??= context.varIndex++;
					paramMap.push([name, nextNode.#varIndex]);
				}
			} else {
				keys.push(token);
				nextNode = node.#children[token];
				if (!nextNode) {
					for (const k in node.#children) if (k.length > 1 && k !== "[^]*" && k !== "(?:|/[^]*)") throw PATH_ERROR;
					nextNode = node.#children[token] = new Node();
				}
			}
			node = nextNode;
		}
		if (node.#index !== void 0) throw PATH_ERROR;
		node.#index = index;
	}
	buildRegExpStr() {
		const strList = Object.keys(this.#children).sort(compareKey).map((k) => {
			const c = this.#children[k];
			const childStr = c.buildRegExpStr();
			return childStr === "" ? "" : (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + childStr;
		}).filter(Boolean);
		if (typeof this.#index === "number" && this.#index !== -1) strList.unshift(`#${this.#index}`);
		if (strList.length === 0) return "";
		if (strList.length === 1) return strList[0];
		return "(?:" + strList.join("|") + ")";
	}
};
// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
	#context = { varIndex: 0 };
	#root = new Node$1();
	#index = 0;
	paths = createNullObject();
	insert(path, isStatic) {
		const keys = [];
		if (isStatic) {
			this.#root.insert(path.split(""), -1, [], this.#context, keys);
			this.paths[path] = [
				-1,
				[],
				keys
			];
			return;
		}
		const paramAssoc = [];
		const groups = [];
		let markedPath = path;
		for (let i = 0;;) {
			let replaced = false;
			markedPath = markedPath.replace(/\{(?:\{[\d,]+\}|[^}])+\}/g, (m) => {
				const mark = `@\\${i}`;
				groups[i] = [mark, m];
				i++;
				replaced = true;
				return mark;
			});
			if (!replaced) break;
		}
		/**
		*  - pattern (:label, :label{0-9]+}, ...)
		*  - /* wildcard
		*  - character
		*/
		const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./gs) || [];
		for (let i = groups.length - 1; i >= 0; i--) {
			const [mark] = groups[i];
			for (let j = tokens.length - 1; j >= 0; j--) if (tokens[j].indexOf(mark) !== -1) {
				tokens[j] = tokens[j].replace(mark, groups[i][1]);
				break;
			}
		}
		this.#root.insert(tokens, this.#index, paramAssoc, this.#context, keys);
		this.paths[path] = [
			this.#index++,
			paramAssoc,
			keys
		];
	}
	buildRegExp() {
		let regexp = this.#root.buildRegExpStr();
		if (regexp === "") return [
			/^$/,
			[],
			[]
		];
		let captureIndex = 0;
		const indexReplacementMap = [];
		const paramReplacementMap = [];
		regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
			if (handlerIndex !== void 0) {
				indexReplacementMap[++captureIndex] = Number(handlerIndex);
				return "$()";
			}
			if (paramIndex !== void 0) {
				paramReplacementMap[Number(paramIndex)] = ++captureIndex;
				return "";
			}
			return "";
		});
		return [
			new RegExp(`^${regexp}`),
			indexReplacementMap,
			paramReplacementMap
		];
	}
};
// node_modules/hono/dist/router/reg-exp-router/router.js
function endsWithWildcard(keys) {
	const tail = keys[keys.length - 1];
	return tail === "[^]*" || tail === "(?:|/[^]*)";
}
function covers(wildcard, target) {
	const last = wildcard.length - 1;
	for (let i = 0; i < last; i++) if (wildcard[i] !== target[i]) return false;
	return wildcard[last] === "[^]*" || target.length === last || target[last] === "/";
}
var RegExpRouter = class {
	name = "RegExpRouter";
	#handlers;
	#tries;
	constructor() {
		this.#handlers = { ["ALL"]: [] };
		this.#tries = { ["ALL"]: new Trie() };
	}
	#insertPath(method, path) {
		try {
			this.#tries[method].insert(path, !/\*|\/:/.test(path));
		} catch (e) {
			throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
		}
	}
	add(method, path, handler) {
		const handlers = this.#handlers;
		if (!handlers) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
		const tries = this.#tries;
		if (!handlers[method]) {
			tries[method] = new Trie();
			handlers[method] = [...handlers["ALL"]];
			for (const p in tries["ALL"].paths) this.#insertPath(method, p);
		}
		if (path === "/*") path = "*";
		const methods = method === "ALL" ? Object.keys(handlers) : [method];
		const paths = checkOptionalParameter(path) || [path];
		for (const path of paths) for (const m of methods) {
			if (!tries[m].paths[path]) this.#insertPath(m, path);
			handlers[m].push([handler, path]);
		}
	}
	match = match;
	buildAllMatchers() {
		const matchers = createNullObject();
		for (const method of Object.keys(this.#handlers)) matchers[method] = this.#buildMatcher(method);
		this.#handlers = this.#tries = void 0;
		return matchers;
	}
	#buildMatcher(method) {
		const handlers = this.#handlers[method];
		const trie = this.#tries[method];
		const staticMap = createNullObject();
		const handlerData = [];
		const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
		const own = createNullObject();
		const entries = handlers.map(([h, p], i) => {
			(own[p] ??= []).push(i);
			return [h, trie.paths[p][1].reduceRight((map, [key, varIndex]) => {
				map[key] = paramReplacementMap[varIndex];
				return map;
			}, createNullObject())];
		});
		const wildcards = Object.keys(own).filter((p) => endsWithWildcard(trie.paths[p][2]));
		for (const path in trie.paths) {
			const [index, , keys] = trie.paths[path];
			const indexes = [...own[path]];
			for (const p of wildcards) if (p !== path && covers(trie.paths[p][2], keys)) indexes.push(...own[p]);
			const data = indexes.sort((a, b) => a - b).map((i) => entries[i]);
			if (index === -1) {
				const last = Math.max(-1, ...data.flatMap(([, map]) => Object.values(map)));
				staticMap[path] = [data, last === -1 ? emptyParam : path.match(regexp).slice(0, last + 1)];
			} else handlerData[index] = data;
		}
		return [
			regexp,
			indexReplacementMap.map((i) => handlerData[i]),
			staticMap
		];
	}
};
// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
	name = "SmartRouter";
	#routers = [];
	#routes = [];
	constructor(init) {
		this.#routers = init.routers;
	}
	add(method, path, handler) {
		if (!this.#routes) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
		this.#routes.push([
			method,
			path,
			handler
		]);
	}
	match(method, path) {
		if (!this.#routes) throw new Error("Fatal error");
		const routers = this.#routers;
		const routes = this.#routes;
		const len = routers.length;
		let i = 0;
		let res;
		for (; i < len; i++) {
			const router = routers[i];
			try {
				for (let i = 0, len = routes.length; i < len; i++) router.add(...routes[i]);
				res = router.match(method, path);
			} catch (e) {
				if (e instanceof UnsupportedPathError) continue;
				throw e;
			}
			this.match = router.match.bind(router);
			this.#routers = [router];
			this.#routes = void 0;
			break;
		}
		if (i === len) throw new Error("Fatal error");
		this.name = `SmartRouter + ${this.activeRouter.name}`;
		return res;
	}
	get activeRouter() {
		if (this.#routes || this.#routers.length !== 1) throw new Error("No active router has been determined yet.");
		return this.#routers[0];
	}
};
// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = createNullObject();
var order = 0;
var Node = class Node {
	#methods = [];
	#children = createNullObject();
	#patterns = [];
	#pattern;
	#params = emptyParams;
	insert(method, path, handler) {
		let curNode = this;
		const parts = splitRoutingPath(path);
		const possibleKeys = /* @__PURE__ */ new Set();
		let i = 0;
		for (const p of parts) {
			const nextP = parts[++i];
			const pattern = getPattern(p, nextP) || (nextP === void 0 && p && p.indexOf("*") === p.length - 1 ? p : null);
			const isParam = Array.isArray(pattern);
			const key = isParam ? pattern[0] : pattern || p;
			const child = curNode.#children[key] ||= new Node();
			if (pattern && !child.#pattern) {
				child.#pattern = pattern;
				curNode.#patterns.push(child);
			}
			curNode = child;
			if (isParam) possibleKeys.add(pattern[1]);
		}
		curNode.#methods.push({ [method]: {
			handler,
			possibleKeys: [...possibleKeys],
			score: ++order
		} });
	}
	#pushHandlerSets(handlerSets, node, method, nodeParams, params) {
		for (let i = 0, len = node.#methods.length; i < len; i++) {
			const m = node.#methods[i];
			const handlerSet = m[method] || m["ALL"];
			if (handlerSet) {
				handlerSet.params = createNullObject();
				handlerSets.push(handlerSet);
				for (let i = 0, len = handlerSet.possibleKeys.length; i < len; i++) {
					const key = handlerSet.possibleKeys[i];
					handlerSet.params[key] = params?.[key] && !i ? params[key] : nodeParams[key] ?? params?.[key];
				}
			}
		}
	}
	search(method, path) {
		const handlerSets = [];
		this.#params = emptyParams;
		let curNodes = [this];
		const parts = splitPath(path);
		const curNodesQueue = [];
		const len = parts.length;
		let partOffsets = null;
		for (let i = 0; i < len; i++) {
			const part = parts[i];
			const isLast = i === len - 1;
			const tempNodes = [];
			for (let j = 0, len2 = curNodes.length; j < len2; j++) {
				const node = curNodes[j];
				const nextNode = node.#children[part];
				if (nextNode) {
					nextNode.#params = node.#params;
					if (isLast) {
						if (nextNode.#children["*"]) this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
						this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
					} else tempNodes.push(nextNode);
				}
				for (const child of node.#patterns) {
					const pattern = child.#pattern;
					const params = node.#params === emptyParams ? {} : { ...node.#params };
					if (typeof pattern === "string") {
						if (pattern === "*" || part.startsWith(pattern.slice(0, -1))) {
							this.#pushHandlerSets(handlerSets, child, method, node.#params);
							if (pattern === "*") {
								child.#params = params;
								tempNodes.push(child);
							}
						}
						continue;
					}
					const [, name, matcher] = pattern;
					if (!part && matcher === true) continue;
					if (matcher !== true) {
						if (!partOffsets) {
							partOffsets = [];
							let offset = path[0] === "/" ? 1 : 0;
							for (let p = 0; p < len; p++) {
								partOffsets[p] = offset;
								offset += parts[p].length + 1;
							}
						}
						const restPathString = path.slice(partOffsets[i]);
						const m = matcher.exec(restPathString);
						if (m) {
							if (!Object.hasOwn(params, name)) params[name] = m[0];
							this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
							if (m[0].length === restPathString.length && child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, node.#params, params);
							for (const _ in child.#children) {
								child.#params = params;
								const componentCount = m[0].match(/\//g)?.length ?? 0;
								(curNodesQueue[componentCount] ||= []).push(child);
								break;
							}
							continue;
						}
					}
					if (matcher === true || matcher.test(part)) {
						if (!Object.hasOwn(params, name)) params[name] = part;
						if (isLast) {
							this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
							if (child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, params, node.#params);
						} else {
							child.#params = params;
							tempNodes.push(child);
						}
					}
				}
			}
			const shifted = curNodesQueue.shift();
			curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
		}
		if (handlerSets[1]) handlerSets.sort((a, b) => {
			return a.score - b.score;
		});
		return [handlerSets.map(({ handler, params }) => [handler, params])];
	}
};
// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
	name = "TrieRouter";
	#node = new Node();
	add(method, path, handler) {
		for (const result of checkOptionalParameter(path) || [path]) this.#node.insert(method, result, handler);
	}
	match(method, path) {
		return this.#node.search(method, path);
	}
};
// node_modules/hono/dist/hono.js
/**
* The Hono class extends the functionality of the HonoBase class.
* It sets up routing and allows for custom options to be passed.
*
* @template E - The environment type.
* @template S - The schema type.
* @template BasePath - The base path type.
*/
var Hono = class extends Hono$1 {
	/**
	* Creates an instance of the Hono class.
	*
	* @param options - Optional configuration options for the Hono instance.
	*/
	constructor(options = {}) {
		super(options);
		this.router = options.router ?? new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] });
	}
};
// node_modules/hono/dist/utils/accept.js
var isWhitespace = (char) => char === 32 || char === 9 || char === 10 || char === 13;
var consumeWhitespace = (acceptHeader, startIndex) => {
	while (startIndex < acceptHeader.length) {
		if (!isWhitespace(acceptHeader.charCodeAt(startIndex))) break;
		startIndex++;
	}
	return startIndex;
};
var ignoreTrailingWhitespace = (acceptHeader, startIndex) => {
	while (startIndex > 0) {
		if (!isWhitespace(acceptHeader.charCodeAt(startIndex - 1))) break;
		startIndex--;
	}
	return startIndex;
};
var skipInvalidParam = (acceptHeader, startIndex) => {
	while (startIndex < acceptHeader.length) {
		const char = acceptHeader.charCodeAt(startIndex);
		if (char === 59) return [startIndex + 1, true];
		if (char === 44) return [startIndex + 1, false];
		startIndex++;
	}
	return [startIndex, false];
};
var skipInvalidAcceptValue = (acceptHeader, startIndex) => {
	let i = startIndex;
	let inQuotes = false;
	while (i < acceptHeader.length) {
		const char = acceptHeader.charCodeAt(i);
		if (inQuotes && char === 92) i++;
		else if (char === 34) inQuotes = !inQuotes;
		else if (!inQuotes && char === 44) return i + 1;
		i++;
	}
	return i;
};
var getNextParam = (acceptHeader, startIndex) => {
	startIndex = consumeWhitespace(acceptHeader, startIndex);
	let i = startIndex;
	let key;
	let value;
	let hasNext = false;
	while (i < acceptHeader.length) {
		const char = acceptHeader.charCodeAt(i);
		if (char === 61) {
			key = acceptHeader.slice(startIndex, ignoreTrailingWhitespace(acceptHeader, i));
			i++;
			break;
		}
		if (char === 59) return [
			i + 1,
			void 0,
			void 0,
			true
		];
		if (char === 44) return [
			i + 1,
			void 0,
			void 0,
			false
		];
		i++;
	}
	if (key === void 0) return [
		i,
		void 0,
		void 0,
		false
	];
	i = consumeWhitespace(acceptHeader, i);
	if (acceptHeader.charCodeAt(i) === 61) {
		const skipResult = skipInvalidParam(acceptHeader, i + 1);
		return [
			skipResult[0],
			key,
			void 0,
			skipResult[1]
		];
	}
	let inQuotes = false;
	const paramStartIndex = i;
	while (i < acceptHeader.length) {
		const char = acceptHeader.charCodeAt(i);
		if (inQuotes && char === 92) i++;
		else if (char === 34) {
			if (inQuotes) {
				let nextIndex = consumeWhitespace(acceptHeader, i + 1);
				const nextChar = acceptHeader.charCodeAt(nextIndex);
				if (nextIndex < acceptHeader.length && !(nextChar === 59 || nextChar === 44)) {
					const skipResult = skipInvalidParam(acceptHeader, nextIndex);
					return [
						skipResult[0],
						key,
						void 0,
						skipResult[1]
					];
				}
				value = acceptHeader.slice(paramStartIndex + 1, i);
				if (value.includes("\\")) value = value.replace(/\\(.)/g, "$1");
				if (nextChar === 44) return [
					nextIndex + 1,
					key,
					value,
					false
				];
				if (nextChar === 59) {
					hasNext = true;
					nextIndex++;
				}
				i = nextIndex;
				break;
			}
			inQuotes = true;
		} else if (!inQuotes && (char === 59 || char === 44)) {
			value = acceptHeader.slice(paramStartIndex, ignoreTrailingWhitespace(acceptHeader, i));
			if (char === 59) hasNext = true;
			i++;
			break;
		}
		i++;
	}
	return [
		i,
		key,
		value ?? acceptHeader.slice(paramStartIndex, ignoreTrailingWhitespace(acceptHeader, i)),
		hasNext
	];
};
var getNextAcceptValue = (acceptHeader, startIndex) => {
	const accept = {
		type: "",
		params: Object.create(null),
		q: 1
	};
	startIndex = consumeWhitespace(acceptHeader, startIndex);
	let i = startIndex;
	while (i < acceptHeader.length) {
		const char = acceptHeader.charCodeAt(i);
		if (char === 59 || char === 44) {
			accept.type = acceptHeader.slice(startIndex, ignoreTrailingWhitespace(acceptHeader, i));
			i++;
			if (char === 44) return [i, accept.type ? accept : void 0];
			if (!accept.type) return [skipInvalidAcceptValue(acceptHeader, i), void 0];
			break;
		}
		i++;
	}
	if (!accept.type) {
		accept.type = acceptHeader.slice(startIndex, ignoreTrailingWhitespace(acceptHeader, acceptHeader.length));
		return [acceptHeader.length, accept.type ? accept : void 0];
	}
	let param;
	let value;
	let hasNext;
	while (i < acceptHeader.length) {
		[i, param, value, hasNext] = getNextParam(acceptHeader, i);
		if (param && value) accept.params[param] = value;
		if (!hasNext) break;
	}
	return [i, accept];
};
var parseAccept = (acceptHeader) => {
	if (!acceptHeader) return [];
	const values = [];
	let i = 0;
	let accept;
	let requiresSort = false;
	let lastAccept;
	while (i < acceptHeader.length) {
		[i, accept] = getNextAcceptValue(acceptHeader, i);
		if (accept) {
			accept.q = parseQuality(accept.params.q ?? accept.params.Q);
			values.push(accept);
			if (lastAccept && lastAccept.q < accept.q) requiresSort = true;
			lastAccept = accept;
		}
	}
	if (requiresSort) values.sort((a, b) => b.q - a.q);
	return values;
};
var parseQuality = (qVal) => {
	if (qVal === void 0) return 1;
	if (qVal === "") return 1;
	if (qVal === "NaN") return 0;
	const num = Number(qVal);
	if (Number.isNaN(num)) return 1;
	if (num < 0) return 0;
	if (num > 1) return 1;
	return num;
};
// node_modules/hono/dist/utils/compress.js
/**
* @module
* Constants for compression.
*/
/**
* Match for compressible content type.
*/
var COMPRESSIBLE_CONTENT_TYPE_REGEX = /^\s*(?:text\/(?!event-stream(?:[;\s]|$))[^;\s]+|application\/(?:javascript|json|xml|xml-dtd|ecmascript|dart|msgpack|postscript|rtf|tar|toml|vnd\.dart|vnd\.ms-fontobject|vnd\.ms-opentype|vnd\.msgpack|wasm|x-httpd-php|x-javascript|x-msgpack|x-ns-proxy-autoconfig|x-sh|x-tar|x-virtualbox-hdd|x-virtualbox-ova|x-virtualbox-ovf|x-virtualbox-vbox|x-virtualbox-vdi|x-virtualbox-vhd|x-virtualbox-vmdk|x-www-form-urlencoded)|font\/(?:otf|ttf)|image\/(?:bmp|vnd\.adobe\.photoshop|vnd\.microsoft\.icon|vnd\.ms-dds|x-icon|x-ms-bmp)|message\/rfc822|model\/gltf-binary|x-shader\/x-fragment|x-shader\/x-vertex|[^;\s]+?\+(?:json|text|xml|yaml|msgpack))(?:[;\s]|$)/i;
// node_modules/hono/dist/middleware/compress/index.js
var ENCODING_TYPES = ["gzip", "deflate"];
var cacheControlNoTransformRegExp = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i;
var selectEncoding = (header, candidates) => {
	if (header === void 0) return;
	const accepts = parseAccept(header);
	const wildcardQ = accepts.find((a) => a.type === "*")?.q;
	let best;
	for (const enc of candidates) {
		const explicit = accepts.find((a) => a.type.toLowerCase() === enc);
		const q = explicit ? explicit.q : wildcardQ ?? 0;
		if (q === 1) return enc;
		else if (q > 0 && (!best || q > best.q)) best = {
			encoding: enc,
			q
		};
	}
	return best?.encoding;
};
var varyAcceptEncodingRegExp = /(?:^|,)\s*accept-encoding\s*(?:,|$)/i;
/**
* Compress Middleware for Hono.
*
* @see {@link https://hono.dev/docs/middleware/builtin/compress}
*
* @param {CompressionOptions} [options] - The options for the compress middleware.
* @param {'gzip' | 'deflate'} [options.encoding] - The compression scheme to allow for response compression. Either 'gzip' or 'deflate'. If not defined, both are allowed and will be used based on the Accept-Encoding header. 'gzip' is prioritized if this option is not provided and the client provides both in the Accept-Encoding header.
* @param {number} [options.threshold=1024] - The minimum size in bytes to compress. Defaults to 1024 bytes.
* @param {RegExp | Function} [options.contentTypeFilter=COMPRESSIBLE_CONTENT_TYPE_REGEX] - A RegExp or function to determine if the response Content-Type should be compressed.
* @returns {MiddlewareHandler} The middleware handler function.
*
* @example
* ```ts
* const app = new Hono()
*
* app.use(compress())
*
* // Compress only JSON responses
* app.use(compress({ contentTypeFilter: /^application\/json/ }))
*
* // Compress based on custom Content-Type logic
* app.use(compress({ contentTypeFilter: (type) => COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type) || type === "application/x-myformat" }))
* ```
*/
var compress = (options) => {
	const threshold = options?.threshold ?? 1024;
	const candidates = options?.encoding ? [options.encoding] : ENCODING_TYPES;
	const contentTypeFilter = options?.contentTypeFilter ?? COMPRESSIBLE_CONTENT_TYPE_REGEX;
	const shouldCompress = typeof contentTypeFilter === "function" ? (res) => {
		const type = res.headers.get("Content-Type");
		return type && contentTypeFilter(type);
	} : (res) => {
		const type = res.headers.get("Content-Type");
		return type && contentTypeFilter.test(type);
	};
	return async function compress(ctx, next) {
		await next();
		const contentLength = ctx.res.headers.get("Content-Length");
		if (ctx.res.status === 206 || ctx.res.headers.has("Content-Encoding") || ctx.res.headers.has("Transfer-Encoding") || contentLength && Number(contentLength) < threshold || !shouldCompress(ctx.res) || !shouldTransform(ctx.res)) return;
		const current = ctx.res.headers.get("Vary");
		if (current !== "*" && !(current && varyAcceptEncodingRegExp.test(current))) ctx.header("Vary", current ? `${current}, Accept-Encoding` : "Accept-Encoding");
		const encoding = selectEncoding(ctx.req.header("Accept-Encoding"), candidates);
		if (!encoding || !ctx.res.body) return;
		ctx.res = ctx.req.method === "HEAD" ? new Response(null, ctx.res) : new Response(ctx.res.body.pipeThrough(new CompressionStream(encoding)), ctx.res);
		ctx.res.headers.delete("Content-Length");
		ctx.res.headers.set("Content-Encoding", encoding);
		const etag = ctx.res.headers.get("ETag");
		if (etag && !etag.startsWith("W/")) ctx.res.headers.set("ETag", `W/${etag}`);
	};
};
var shouldTransform = (res) => {
	const cacheControl = res.headers.get("Cache-Control");
	return !cacheControl || !cacheControlNoTransformRegExp.test(cacheControl);
};
// server/bitjita.ts
var BASE = "https://bitjita.com/api";
var APP = "nowhere-craft-tracker (one claim, cached)";
/** Seconds each kind of answer is reused before asking Bitjita again. */
var TTL = {
	claim: 3600,
	members: 21600,
	buildings: 3600,
	houseList: 43200,
	/** Chest, bag and craft contents. Reused for as long as the snapshot they belong to. */
	storage: 900,
	/** How long the assembled snapshot is the answer for everyone. */
	snapshot: 900,
	/** How much longer a complete snapshot is kept, to fall back on when a newer read comes back with gaps. */
	fallback: 3600,
	/** After a newer read fails, how long everyone gets the older one before Bitjita is tried again. */
	holdOff: 300
};
/** Bump when what a snapshot contains changes, so copies saved in the old shape are not served. */
var SNAPSHOT_SHAPE = 2;
/** Pressing refresh gets a newer snapshot only if the current one is at least this old. */
var MIN_REFRESH_SECONDS = 300;
/** Never more than this many requests to Bitjita at the same moment. */
var MAX_IN_FLIGHT = 2;
/** Room for one whole read from cold (about 40 requests), and nothing like a second one. */
var BUDGET_PER_MINUTE = 60;
var BUDGET_PER_HOUR = 240;
var UpstreamError = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.status = status;
	}
};
var inFlight = 0;
var waiting = [];
/** When each request to Bitjita was made, for the last hour. */
var recentCalls = [];
var asking = /* @__PURE__ */ new Map();
var counters = {
	asked: 0,
	reused: 0,
	refused: 0
};
async function slot(work) {
	if (inFlight >= MAX_IN_FLIGHT) await new Promise((go) => waiting.push(go));
	else inFlight++;
	try {
		return await work();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else inFlight--;
	}
}
var since = (ms) => {
	const cutoff = Date.now() - ms;
	let n = 0;
	for (let i = recentCalls.length - 1; i >= 0 && recentCalls[i] > cutoff; i--) n++;
	return n;
};
function spend(path) {
	const now = Date.now();
	while (recentCalls.length && now - recentCalls[0] > 36e5) recentCalls.shift();
	if (since(6e4) >= BUDGET_PER_MINUTE || recentCalls.length >= BUDGET_PER_HOUR) {
		counters.refused++;
		throw new UpstreamError(429, `Holding off: ${since(6e4)} requests to Bitjita in the last minute, ${recentCalls.length} in the last hour (wanted ${path}).`);
	}
	recentCalls.push(now);
	counters.asked++;
}
/** What this server has asked of Bitjita lately, for the status page and the logs. */
function usage() {
	return {
		askedInLastMinute: since(6e4),
		askedInLastHour: since(36e5),
		capPerMinute: BUDGET_PER_MINUTE,
		capPerHour: BUDGET_PER_HOUR,
		bitjitaLimitPerMinute: 250,
		snapshotReusedForMinutes: TTL.snapshot / 60,
		refreshAtMostEveryMinutes: MIN_REFRESH_SECONDS / 60,
		sinceStart: { ...counters }
	};
}
/**
* GET a Bitjita path as JSON, reused for `ttl` seconds. `missing` is returned when
* Bitjita has nothing there (and that answer is remembered as well). `force` skips
* the remembered answer, for an explicit refresh.
*/
async function get(memo, path, ttl, missing, force = false) {
	const url = BASE + path;
	let body;
	if (!force) {
		const hit = await memo.get(url);
		if (hit !== null) {
			counters.reused++;
			body = hit === "null" ? null : hit;
		}
	}
	if (body === void 0) {
		let pending = asking.get(url);
		if (!pending) {
			pending = slot(async () => {
				spend(path);
				const res = await fetch(url, { headers: {
					"user-agent": APP,
					"x-app-identifier": APP,
					accept: "application/json"
				} });
				if (res.status === 404) {
					memo.set(url, "null", ttl);
					return null;
				}
				if (!res.ok) throw new UpstreamError(res.status === 429 ? 429 : 502, `Bitjita answered ${res.status} for ${path}`);
				const text = await res.text();
				memo.set(url, text, ttl);
				return text;
			}).finally(() => asking.delete(url));
			asking.set(url, pending);
		} else counters.reused++;
		body = await pending;
	}
	if (body === null) {
		if (missing !== void 0) return missing;
		throw new UpstreamError(502, `Bitjita has nothing at ${path}`);
	}
	return JSON.parse(body);
}
var ref = (id, type) => (type === 1 || type === "cargo" || type === "Cargo" ? "c." : "i.") + id;
/** Adds up a list of storage slots into [thing, quantity] pairs. */
function tally(slots) {
	const totals = /* @__PURE__ */ new Map();
	for (const slot of slots ?? []) {
		const c = slot?.contents;
		if (!c) continue;
		const id = ref(c.item_id ?? c.itemId, c.item_type ?? c.itemType);
		totals.set(id, (totals.get(id) ?? 0) + (Number(c.quantity) || 0));
	}
	return [...totals];
}
async function claimDetail(memo, id) {
	const [claim, members] = await Promise.all([get(memo, `/claims/${id}`, TTL.claim), get(memo, `/claims/${id}/members`, TTL.members, { members: [] })]);
	const c = claim.claim;
	return {
		id: String(c.entityId),
		name: c.name,
		tier: c.tier ?? 0,
		region: c.regionName ?? "",
		owner: c.ownerPlayerUsername ?? "",
		supplies: Number(c.supplies) || 0,
		members: (members.members ?? []).map((m) => ({
			id: String(m.playerEntityId),
			name: m.userName,
			lastSeen: m.lastLoginTimestamp ?? null
		}))
	};
}
/**
* Everything the claim and the given members are holding, plus crafts on the go.
* Only members of the claim are ever looked up, whatever ids are passed in.
* `fresh` is someone pressing refresh: honoured only when the snapshot on hand is old enough.
*/
async function stockSnapshot(memo, claimId, wantedPlayers, fresh = false) {
	const detail = await claimDetail(memo, claimId);
	const members = new Map(detail.members.map((m) => [m.id, m.name]));
	const playerIds = [...new Set(wantedPlayers)].filter((id) => members.has(id)).sort();
	const whole = `https://snapshot.internal/v${SNAPSHOT_SHAPE}/${claimId}?players=${playerIds.join(",")}`;
	const held = await memo.get(whole + "&held=1");
	if (held) return JSON.parse(held);
	const ready = await memo.get(whole);
	let previous = null;
	if (ready) {
		const snapshot = JSON.parse(ready);
		if ((Date.now() - new Date(snapshot.at).getTime()) / 1e3 < (fresh ? MIN_REFRESH_SECONDS : TTL.snapshot)) return snapshot;
		previous = snapshot;
	}
	const force = fresh;
	const locations = [];
	const problems = [];
	const claimPart = (async () => {
		const inv = await get(memo, `/claims/${claimId}/inventories`, TTL.storage, void 0, force);
		for (const b of inv.buildings ?? []) locations.push({
			id: "b" + b.entityId,
			kind: "claim",
			owner: detail.name,
			name: b.buildingNickname || b.buildingName,
			detail: b.buildingNickname ? b.buildingName : "",
			items: tally(b.inventory)
		});
		const built = await get(memo, `/claims/${claimId}/buildings`, TTL.buildings, []).catch(() => []);
		const counts = /* @__PURE__ */ new Map();
		for (const b of Array.isArray(built) ? built : []) counts.set("b." + b.buildingDescriptionId, (counts.get("b." + b.buildingDescriptionId) ?? 0) + 1);
		if (counts.size) locations.push({
			id: "built",
			kind: "claim",
			owner: detail.name,
			name: "Standing in the claim",
			detail: "Buildings",
			items: [...counts]
		});
	})();
	const crafts = [];
	const playerParts = playerIds.map(async (pid) => {
		const owner = members.get(pid) ?? "Member";
		try {
			const [active, passive] = await Promise.all([get(memo, `/players/${pid}/crafts?completed=all`, TTL.storage, { craftResults: [] }, force), get(memo, `/players/${pid}/passive-crafts?status=all`, TTL.storage, { craftResults: [] }, force)]);
			for (const c of active.craftResults ?? []) {
				const made = c.craftedItem?.[0];
				if (!made) continue;
				crafts.push({
					id: String(c.entityId),
					item: ref(made.item_id, made.item_type),
					qty: (Number(made.quantity) || 1) * (Number(c.craftCount) || 1),
					owner,
					ownerId: pid,
					station: c.buildingName ?? "",
					claim: c.claimName ?? "",
					passive: false,
					progress: Number(c.progress) || 0,
					total: Number(c.totalActionsRequired) || 0,
					done: !!c.completed,
					shared: !!c.isPublic
				});
			}
			const batches = /* @__PURE__ */ new Map();
			for (const c of passive.craftResults ?? []) {
				const made = c.craftedItem?.[0];
				if (!made) continue;
				const item = ref(made.item_id, made.item_type);
				const done = /complete/i.test(String(c.status ?? ""));
				const key = `${c.buildingEntityId}|${item}|${done}`;
				const batch = batches.get(key);
				if (batch) batch.qty += Number(made.quantity) || 1;
				else batches.set(key, {
					id: `passive:${pid}:${key}`,
					item,
					qty: Number(made.quantity) || 1,
					owner,
					ownerId: pid,
					station: c.buildingName ?? "",
					claim: c.claimName ?? "",
					passive: true,
					progress: 0,
					total: 0,
					done,
					shared: false
				});
			}
			crafts.push(...batches.values());
		} catch (err) {
			problems.push(`Could not read ${owner}'s crafts (${err.message}).`);
		}
		try {
			const inv = await get(memo, `/players/${pid}/inventories`, TTL.storage, void 0, force);
			for (const box of inv.inventories ?? []) {
				const items = tally(box.pockets);
				if (!items.length) continue;
				const where = box.claimName ? `${box.inventoryName ?? box.buildingName} @ ${box.claimName}` : box.inventoryName ?? box.buildingName ?? "Storage";
				locations.push({
					id: "p" + pid + ":" + box.entityId,
					kind: "player",
					owner,
					ownerId: pid,
					name: where,
					detail: "",
					items
				});
			}
		} catch (err) {
			problems.push(`Could not read ${owner}'s storage (${err.message}).`);
		}
		try {
			let houses = await get(memo, `/players/${pid}/housing`, TTL.houseList, []);
			if (!Array.isArray(houses)) houses = [houses];
			for (const h of houses) {
				if (!h || h.isEmpty || !h.buildingEntityId) continue;
				const house = await get(memo, `/players/${pid}/housing/${h.buildingEntityId}`, TTL.storage, { inventories: [] }, force);
				for (const box of house.inventories ?? []) {
					const items = tally(box.inventory);
					if (!items.length) continue;
					locations.push({
						id: "h" + pid + ":" + box.entityId,
						kind: "player",
						owner,
						ownerId: pid,
						name: "House: " + (box.buildingNickname || box.buildingName || "storage"),
						detail: "",
						items
					});
				}
			}
		} catch {}
	});
	const [claimRead] = await Promise.allSettled([claimPart, ...playerParts]);
	if (claimRead.status === "rejected") {
		if (!previous) throw claimRead.reason;
		problems.push(`Could not read the claim's storage (${claimRead.reason.message}).`);
	}
	if (problems.length && previous) {
		const older = {
			...previous,
			problems: [`Could not get a newer read, so this is still the one from earlier. ${problems[0]}`]
		};
		memo.set(whole + "&held=1", JSON.stringify(older), TTL.holdOff);
		return older;
	}
	const snapshot = {
		at: (/* @__PURE__ */ new Date()).toISOString(),
		claim: {
			id: detail.id,
			name: detail.name,
			tier: detail.tier
		},
		locations,
		crafts,
		problems
	};
	if (!problems.length) memo.set(whole, JSON.stringify(snapshot), TTL.snapshot + TTL.fallback);
	return snapshot;
}
// src/lib/claim.ts
/**
* This is an internal tool for one claim. Both the site and the server read the
* claim from here, and the server refuses to look up anything else.
*/
var CLAIM = {
	/** The claim's id in the game (and on Bitjita). */
	id: "576460753011209206",
	/** Its place in the address bar: /nowhere/claim-t5-push */
	slug: "nowhere",
	name: "Nowhere"
};
/**
* The site lives inside the Companion app, which serves everything under /nowhere
* from here (see server/embed.ts) and keeps every other address for itself.
*/
var HOME = "/" + CLAIM.slug;
/** The site's own API. The Companion's /api/… is its pass-through to Bitjita, a different thing. */
var API = HOME + "/api";
/** Pages of the site that sit where a push's address would, so no push may take these names. */
var RESERVED_SLUGS = [
	"travelers",
	"pushes",
	"api",
	"assets"
];
var MAIN_OF = new Map([
	{
		main: "Velcruza",
		alts: ["Vel", "Cynth"]
	},
	{
		main: "chels",
		alts: ["pumapance"]
	},
	{
		main: "skyediver",
		alts: ["whitelinx"]
	},
	{ main: "Frostyy" },
	{ main: "Silentstorm" }
].flatMap((p) => (p.alts ?? []).map((alt) => [alt.toLowerCase(), p.main])));
Object.fromEntries(MAIN_OF);
// server/app.ts
/**
* The site's API, written once for every place it can be hosted.
*
* It needs two things from whoever runs it (see `Host`): somewhere durable to keep
* the board, and somewhere to remember Bitjita's answers. `server/embed.ts` supplies
* both when the Companion app starts the site.
*
* Every address here starts with /nowhere/api (`API`): plain /api/… on the same
* host is the Companion's pass-through to Bitjita.
*/
/** The key the one board is stored under. */
var BOARD_KEY = "board:" + CLAIM.id;
var ID = /^\d{1,24}$/;
var REF = /^[icb]\.\d{1,12}$/;
var slugify = (text) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
async function sha256(text) {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
var publicBoard = ({ keyHash, ...board }, host) => ({
	...board,
	locked: !!keyHash,
	...host.durable ? {} : { temporary: true }
});
/** The one board this tool has. It is created the first time anyone opens it. */
async function loadBoard(kv) {
	const raw = await kv.get(BOARD_KEY);
	if (raw) return JSON.parse(raw);
	const board = {
		claimId: CLAIM.id,
		name: CLAIM.name,
		slug: CLAIM.slug,
		region: "",
		pushes: []
	};
	await saveBoard(kv, board);
	return board;
}
var saveBoard = (kv, board) => kv.put("board:" + board.claimId, JSON.stringify(board));
/** A locked board only accepts changes that come with its password. */
async function mayEdit(board, key) {
	if (!board.keyHash) return true;
	return !!key && await sha256(board.claimId + ":" + key) === board.keyHash;
}
/** Keeps only well-formed fields, so nothing odd is ever stored or served back. */
function cleanPush(input, slug, previous) {
	const name = String(input?.name ?? "").trim().slice(0, 80);
	if (!name) return "A push needs a name.";
	const kinds = [
		"claim-tier",
		"tool-push",
		"traveler",
		"custom"
	];
	const statuses = [
		"active",
		"planned",
		"done"
	];
	const goals = (Array.isArray(input.goals) ? input.goals : []).filter((g) => REF.test(g?.id) && Number.isFinite(g?.qty) && g.qty > 0 && g.qty <= 1e7).slice(0, 300).map((g) => ({
		id: String(g.id),
		qty: Math.round(g.qty)
	}));
	const routes = {};
	for (const [id, recipe] of Object.entries(input.routes ?? {}).slice(0, 500)) if (REF.test(id) && (recipe === null || /^[a-z]\d{1,12}$/.test(String(recipe)))) routes[id] = recipe;
	const assignments = {};
	for (const [id, people] of Object.entries(input.assignments ?? {}).slice(0, 600)) {
		if (!REF.test(id) || !Array.isArray(people)) continue;
		const members = [...new Set(people.map(String).filter((p) => ID.test(p) || p === "buy-order"))].slice(0, 20);
		if (members.length) assignments[id] = members;
	}
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const status = statuses.includes(input.status) ? input.status : "active";
	return {
		slug,
		name,
		kind: kinds.includes(input.kind) ? input.kind : "custom",
		status,
		note: String(input.note ?? "").slice(0, 600) || void 0,
		goals,
		players: (Array.isArray(input.players) ? input.players : []).map(String).filter((p) => ID.test(p)).slice(0, 60),
		leftOut: Array.isArray(input.leftOut) ? [...new Set(input.leftOut.map(String).filter((p) => ID.test(p)))].slice(0, 60) : void 0,
		excluded: (Array.isArray(input.excluded) ? input.excluded : []).map(String).filter((x) => /^[bph][\d:]{1,60}$/.test(x)).slice(0, 400),
		excludedNames: Array.isArray(input.excludedNames) ? [...new Set(input.excludedNames.map((n) => String(n).trim().slice(0, 60)).filter(Boolean))].slice(0, 100) : void 0,
		routes,
		countCrafts: input.countCrafts !== false,
		assignments,
		completedAt: status === "done" ? previous?.status === "done" ? previous.completedAt ?? previous.updatedAt : now : void 0,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now
	};
}
/** Everything under /boards/:slug is for the one claim; any other name simply does not exist. */
var notOurs = (slug) => slug !== CLAIM.slug;
var NO_BOARD = { error: `This tool only tracks ${CLAIM.name}.` };
var LOCKED = { error: "This board is locked. Enter its password to make changes." };
function createApp(hostOf) {
	const app = new Hono();
	const api = app.basePath(API);
	api.get("/claim", async (c) => c.json(await claimDetail(hostOf(c).memo, CLAIM.id)));
	api.get("/stock", async (c) => {
		const players = (c.req.query("players") ?? "").split(",").filter((p) => ID.test(p)).slice(0, 60);
		return c.json(await stockSnapshot(hostOf(c).memo, CLAIM.id, players, c.req.query("fresh") === "1"));
	});
	/** How hard this server has been leaning on Bitjita. */
	api.get("/status", (c) => c.json(usage()));
	/** For the host's "is it up" check. Touches nothing outside this process. */
	api.get("/health", (c) => {
		const host = hostOf(c);
		return c.json({
			ok: true,
			storage: host.storage,
			keepsPushes: host.durable
		});
	});
	api.get("/boards/:slug", async (c) => {
		if (notOurs(c.req.param("slug"))) return c.json(NO_BOARD, 404);
		const host = hostOf(c);
		return c.json(publicBoard(await loadBoard(host.store), host));
	});
	api.put("/boards/:slug/pushes/:push", async (c) => {
		if (notOurs(c.req.param("slug"))) return c.json(NO_BOARD, 404);
		const host = hostOf(c);
		const board = await loadBoard(host.store);
		if (!await mayEdit(board, c.req.header("x-edit-key"))) return c.json(LOCKED, 403);
		const body = await c.req.json().catch(() => null);
		const wanted = c.req.param("push");
		const index = board.pushes.findIndex((p) => p.slug === wanted);
		let slug = wanted;
		if (index < 0) {
			const base = slugify(String(body?.name ?? "")) || "push";
			slug = base;
			for (let n = 2; RESERVED_SLUGS.includes(slug) || board.pushes.some((p) => p.slug === slug); n++) slug = `${base}-${n}`;
			if (board.pushes.length >= 200) return c.json({ error: "This board is full. Remove an old push first." }, 400);
		}
		const push = cleanPush(body, slug, board.pushes[index]);
		if (typeof push === "string") return c.json({ error: push }, 400);
		if (index < 0) board.pushes.unshift(push);
		else board.pushes[index] = push;
		await saveBoard(host.store, board);
		return c.json({
			board: publicBoard(board, host),
			push
		});
	});
	api.delete("/boards/:slug/pushes/:push", async (c) => {
		if (notOurs(c.req.param("slug"))) return c.json(NO_BOARD, 404);
		const host = hostOf(c);
		const board = await loadBoard(host.store);
		if (!await mayEdit(board, c.req.header("x-edit-key"))) return c.json(LOCKED, 403);
		board.pushes = board.pushes.filter((p) => p.slug !== c.req.param("push"));
		await saveBoard(host.store, board);
		return c.json(publicBoard(board, host));
	});
	/** Sets, changes or removes the board's edit password. */
	api.post("/boards/:slug/lock", async (c) => {
		if (notOurs(c.req.param("slug"))) return c.json(NO_BOARD, 404);
		const host = hostOf(c);
		const board = await loadBoard(host.store);
		if (!await mayEdit(board, c.req.header("x-edit-key"))) return c.json({ error: "That password does not match." }, 403);
		const { key } = await c.req.json().catch(() => ({ key: void 0 }));
		if (key && key.length > 100) return c.json({ error: "That password is too long." }, 400);
		board.keyHash = key ? await sha256(board.claimId + ":" + key) : void 0;
		await saveBoard(host.store, board);
		return c.json(publicBoard(board, host));
	});
	/** Checks a password without changing anything, so the site can say "unlocked" up front. */
	api.post("/boards/:slug/unlock", async (c) => {
		if (notOurs(c.req.param("slug"))) return c.json(NO_BOARD, 404);
		return await mayEdit(await loadBoard(hostOf(c).store), c.req.header("x-edit-key")) ? c.json({ ok: true }) : c.json({ error: "That password does not match." }, 403);
	});
	api.all("/*", (c) => c.json({ error: "Not found." }, 404));
	app.onError((err, c) => {
		if (err instanceof UpstreamError) {
			const message = err.status === 429 ? "Giving the game data service a breather. Try again in a minute." : "Could not reach the game data service just now.";
			return c.json({ error: message }, err.status);
		}
		console.error(err);
		return c.json({ error: "Something went wrong on our side." }, 500);
	});
	return app;
}
// server/storage.ts
/**
* Storage for hosts that are not Cloudflare.
*
*  - `memoryMemo`: remembers Bitjita's answers in the server's own memory. Lost on
*    restart, which only costs one fresh read.
*  - `postgresStore`: keeps the board in a Postgres table. The right choice on a host
*    whose files do not survive a restart (Render's free web services).
*  - `fileStore`: keeps the board in one JSON file. Right when the host has a real
*    disk (a Render persistent disk, a VPS, this computer).
*  - `memoryStore`: keeps the board nowhere at all. Only for tests.
*/
function memoryMemo(maxEntries = 400) {
	const kept = /* @__PURE__ */ new Map();
	return {
		async get(key) {
			const hit = kept.get(key);
			if (!hit) return null;
			if (hit.until <= Date.now()) {
				kept.delete(key);
				return null;
			}
			return hit.text;
		},
		set(key, text, ttlSeconds) {
			kept.delete(key);
			kept.set(key, {
				text,
				until: Date.now() + ttlSeconds * 1e3
			});
			if (kept.size <= maxEntries) return;
			const now = Date.now();
			for (const [k, v] of kept) if (v.until <= now) kept.delete(k);
			for (const k of kept.keys()) {
				if (kept.size <= maxEntries) break;
				kept.delete(k);
			}
		}
	};
}
/** One JSON file in `dir`. Writes go one at a time and replace the file whole, so a crash never leaves half a board. */
async function fileStore(dir) {
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, "store.json");
	let data = {};
	try {
		data = JSON.parse(await readFile(file, "utf8"));
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	let writing = Promise.resolve();
	const flush = () => {
		writing = writing.catch(() => {}).then(async () => {
			const tmp = file + ".tmp";
			await writeFile(tmp, JSON.stringify(data));
			await rename(tmp, file);
		});
		return writing;
	};
	return {
		get: async (key) => data[key] ?? null,
		put: async (key, value) => {
			data[key] = value;
			await flush();
		},
		delete: async (key) => {
			delete data[key];
			await flush();
		}
	};
}
/** One small table, `goal_tracker_store (key, value)`, created on first use. */
async function postgresStore(pool) {
	await pool.query("create table if not exists goal_tracker_store (key text primary key, value text not null)");
	return {
		get: async (key) => (await pool.query("select value from goal_tracker_store where key = $1", [key])).rows[0]?.value ?? null,
		put: async (key, value) => void await pool.query("insert into goal_tracker_store (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]),
		delete: async (key) => void await pool.query("delete from goal_tracker_store where key = $1", [key])
	};
}
/** Opens a pool on a `postgres://` address. The client library is only loaded when a database is actually used. */
async function connectPostgres(url) {
	const { default: pg } = await import("./server-esm.mjs");
	return new pg.Pool({
		connectionString: url,
		max: 3
	});
}
// server/embed.ts
/**
* How the Goal Tracker runs inside the Companion app.
*
* The Companion's own server (proxy.js, one folder up) loads the built copy of this
* file, dist/server.mjs, the first time someone opens an address under /nowhere, and
* hands every such request to the function `start` returns. That one function serves
* the built site (dist/client), the game data (public/gamedata.json) and the API
* (/nowhere/api/…). Nothing here listens on a port of its own.
*
*   npm run build   builds the site and this file into dist/, which is committed:
*                   the host runs the Companion with no build step and no packages.
*
* Where the board is kept is chosen from the environment, best first:
*
*   DATABASE_URL  a Postgres address. Use this on hosts whose files vanish on
*                 restart (Render's free web services).
*   DATA_DIR      a folder on a disk that survives restarts (a Render persistent
*                 disk's mount path).
*   neither       the folder the Companion gives us (its data/goal-tracker). Fine on
*                 your own computer; on a host without a real disk the pushes are
*                 lost at every restart, and the site says so.
*/
async function chooseStore(dataDir) {
	const url = process.env.DATABASE_URL?.trim();
	if (url) return {
		store: await postgresStore(await connectPostgres(url)),
		durable: true,
		storage: "postgres"
	};
	const dir = process.env.DATA_DIR?.trim();
	if (dir) return {
		store: await fileStore(dir),
		durable: true,
		storage: "disk"
	};
	const hosted = !!process.env.RENDER;
	return {
		store: await fileStore(dataDir),
		durable: !hosted,
		storage: hosted ? "temporary" : "local-folder"
	};
}
/** A board saved with `npm run export-board` travels in the repository and fills an empty store. */
async function seed(store, file) {
	if (await store.get(BOARD_KEY) !== null || !existsSync(file)) return false;
	const board = JSON.parse(readFileSync(file, "utf8"));
	delete board.keyHash;
	delete board.locked;
	delete board.temporary;
	await store.put(BOARD_KEY, JSON.stringify(board));
	return true;
}
var isFile = (address) => /\.[a-z0-9]+$/i.test(address);
/** Sets the site up and returns what answers one request (Node's own request and response). */
async function start({ root, dataDir }) {
	const site = path.join(root, "dist", "client");
	if (!existsSync(path.join(site, "index.html"))) throw new Error(`No built site at ${site}. Run "npm run build" in ${root} first.`);
	const page = readFileSync(path.join(site, "index.html"), "utf8");
	const chosen = await chooseStore(dataDir);
	const seeded = await seed(chosen.store, path.join(root, "seed", "board.json"));
	const host = {
		...chosen,
		memo: memoryMemo()
	};
	const app = new Hono();
	app.use(compress());
	app.route("/", createApp(() => host));
	app.get("*", (c, next) => isFile(c.req.path) ? next() : c.html(page, 200, { "Cache-Control": "no-cache" }));
	for (const folder of [site, path.join(root, "public")]) app.use("*", serveStatic({
		root: folder,
		rewriteRequestPath: (address) => address.slice(HOME.length),
		onFound: (file, c) => {
			c.header("Cache-Control", /[\\/]assets[\\/]/.test(file) ? "public, max-age=31536000, immutable" : "public, max-age=300");
		}
	}));
	console.log(`Goal Tracker ready at ${HOME}. Board storage: ${host.storage}${seeded ? " (filled from seed/board.json)" : ""}.`);
	if (!host.durable) console.warn("Goal Tracker: no DATABASE_URL or DATA_DIR is set, so pushes will be lost whenever this server restarts.");
	return getRequestListener(app.fetch);
}
export { start };
