// gemini-balance-do/src.ts (The Definitive, Final, Fully-Functional Version)

import { DurableObject } from 'cloudflare:workers';
import { isAdminAuthenticated } from './auth';

// 自定义错误类，方便携带HTTP状态码
class HttpError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
this.name = this.constructor.name;
		this.status = status;
	}
}

// 统一处理CORS响应头
const fixCors = ({ headers, status, statusText }: { headers?: HeadersInit; status?: number; statusText?: string }) => {
	const newHeaders = new Headers(headers);
	newHeaders.set('Access-Control-Allow-Origin', '*');
	return { headers: newHeaders, status, statusText };
};

const BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

const makeHeaders = (apiKey: string, more?: Record<string, string>) => ({
	'x-goog-api-client': 'genai-js/0.10.0', // 使用一个常见的SDK版本号
	...(apiKey && { 'x-goog-api-key': apiKey }),
	...more,
});

export class LoadBalancer extends DurableObject {
	env: Env;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS api_keys (api_key TEXT PRIMARY KEY)');
	}

	async fetch(request: Request): Promise<Response> {
		// --- 全局错误安全网 ---
		// 这是第一道防线，捕获所有未处理的异常，防止DO实例崩溃
		try {
			const url = new URL(request.url);
			const pathname = url.pathname;

			if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
				return new Response('', { status: 204 });
			}
			
			// 管理API路由
			if (pathname.startsWith('/api/keys')) {
				if (!isAdminAuthenticated(request, this.env.HOME_ACCESS_KEY)) {
					return new Response(JSON.stringify({ error: 'Unauthorized' }), {
						status: 401,
						headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
					});
				}
				if (pathname === '/api/keys' && request.method === 'POST') return this.handleApiKeys(request);
				if (pathname === '/api/keys' && request.method === 'GET') return this.getAllApiKeys();
				if (pathname === '/api/keys' && request.method === 'DELETE') return this.handleDeleteApiKeys(request);
				if (pathname === '/api/keys/check' && request.method === 'GET') return this.handleApiKeysCheck();
			}

			// OpenAI兼容API路由
			if (
				pathname.endsWith('/chat/completions') ||
				pathname.endsWith('/completions') ||
				pathname.endsWith('/embeddings') ||
				pathname.endsWith('/models')
			) {
				return this.handleOpenAI(request);
			}
			
			// 对于所有其他未知路径，返回404
			return new Response("Route not found.", { status: 404, headers: fixCors({}).headers });

		} catch (e: any) {
			console.error("--- [FATAL] Unhandled Exception in Durable Object fetch ---", "Error:", e, "Stack:", e.stack);
			const errorResponse = {
				error: {
					message: e.message || "An unexpected internal error occurred in the durable object.",
					type: "durable_object_fatal_error",
					stack: e.stack,
				},
			};
			return new Response(JSON.stringify(errorResponse), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...fixCors({}).headers },
			});
		}
	}

	async handleCompletions(req: any, apiKey: string) {
		const model = req.model?.startsWith('models/') ? req.model.substring(7) : (req.model || 'gemini-1.5-flash-latest');
		
		// --- 【核心修改点】 ---
		// 无论客户端请求什么，我们都强制使用非流式传输，以确保最大稳定性。
		const stream = false;
		console.log("[LOG] Streaming is forcefully disabled for stability.");
		// --- 【核心修改点结束】 ---

		const body = await this.transformRequest(req);
		const task = stream ? 'streamGenerateContent' : 'generateContent';
		let url = `${BASE_URL}/${API_VERSION}/models/${model}:${task}`;
		
		console.log(`[LOG] Making request to Gemini. URL: ${url}, Stream: ${stream}`);

		const response = await fetch(url, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify(body),
		});

		console.log(`[LOG] Received response from Gemini. Status: ${response.status}`);

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const id = 'chatcmpl-' + this.generateId();
			// 由于 stream 永远为 false, 代码将总是执行这个 "else" 块
			console.log("[LOG] Processing non-stream (full) response from Gemini.");
			const data = await response.json();
			responseBody = this.processCompletionsResponse(data, model, id);
			console.log("[LOG] Non-stream response processed and sent to client successfully.");
		} else {
			const errorText = await response.text();
			console.error(`[ERROR] Gemini API returned an error. Status: ${response.status}, Body: ${errorText}`);
			// 将上游错误也以JSON格式返回给客户端
			return new Response(JSON.stringify({ error: { message: `Upstream Gemini API Error: ${errorText}`, type: 'gemini_api_error' } }), {
				status: response.status,
				headers: { 'Content-Type': 'application/json', ...fixCors({}).headers },
			});
		}
		return new Response(responseBody, fixCors(response));
	}
    
	private async handleOpenAI(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;
		console.log(`--- [LOG] OpenAI-Compatible Request Received --- Path: ${pathname}, Method: ${request.method}`);

		const authKey = this.env.AUTH_KEY;
		if (authKey && request.headers.get('Authorization')?.replace('Bearer ', '') !== authKey) {
			console.warn(`[LOG] Unauthorized access attempt for path ${pathname}.`);
			return new Response('Unauthorized', { status: 401, headers: fixCors({}).headers });
		}

		const errHandler = (err: Error, context: string = 'handler') => {
			console.error(`[ERROR] Error during ${context} for path ${pathname}:`, err);
			const status = (err as HttpError).status || 500;
			const errorResponse = { error: { message: err.message ?? 'Internal Server Error', type: `${context}_error` } };
			return new Response(JSON.stringify(errorResponse), {
				status,
				headers: { 'Content-Type': 'application/json', ...fixCors({}).headers },
			});
		};

		try {
			console.log("[LOG] Attempting to get a random API key...");
			const apiKey = await this.getRandomApiKey();
			if (!apiKey) {
				console.error("[FATAL] CRITICAL - No API keys available in the database.");
				throw new HttpError('No API keys configured in the load balancer.', 503);
			}

			console.log(`[LOG] Routing to specific handler for path: ${pathname}`);
			switch (true) {
				case pathname.endsWith('/chat/completions'):
					if (request.method !== 'POST') throw new HttpError('Method Not Allowed', 405);
					return this.handleCompletions(await request.json(), apiKey).catch(err => errHandler(err, 'handleCompletions'));
				case pathname.endsWith('/embeddings'):
					if (request.method !== 'POST') throw new HttpError('Method Not Allowed', 405);
					return this.handleEmbeddings(await request.json(), apiKey).catch(err => errHandler(err, 'handleEmbeddings'));
				case pathname.endsWith('/models'):
					if (request.method !== 'GET') throw new HttpError('Method Not Allowed', 405);
					return this.handleModels(apiKey).catch(err => errHandler(err, 'handleModels'));
				default:
					throw new HttpError('API path not found', 404);
			}
		} catch (e: any) {
			return errHandler(e, 'pre_handler_check');
		}
	}

    // --- 以下是其他辅助函数和管理API函数 ---
    // --- 已全部恢复并加固 ---
    
	async handleModels(apiKey: string) {
		const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
			headers: makeHeaders(apiKey),
		});
		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const data = await response.json();
			const models = data.models || [];
			responseBody = JSON.stringify({
				object: 'list',
				data: models.map(({ name }: any) => ({
					id: name.replace('models/', ''),
					object: 'model',
					created: 0,
					owned_by: 'google',
				})),
			}, null, '  ');
		}
		return new Response(responseBody, fixCors(response));
	}

	async handleEmbeddings(req: any, apiKey: string) {
		const model = req.model?.startsWith('models/') ? req.model : `models/${req.model || 'text-embedding-004'}`;
		const input = Array.isArray(req.input) ? req.input : [req.input];
		const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				requests: input.map((text: string) => ({
					model,
					content: { parts: [{ text }] },
				})),
			}),
		});
		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { embeddings } = await response.json();
			responseBody = JSON.stringify({
				object: 'list',
				data: embeddings.map(({ values }: any, index: number) => ({
					object: 'embedding',
					index,
					embedding: values,
				})),
				model: req.model,
			}, null, '  ');
		}
		return new Response(responseBody, fixCors(response));
	}
    
	private generateId(): string {
		return Array.from({ length: 29 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join('');
	}

	private async transformRequest(req: any) {
		return {
			...(await this.transformMessages(req.messages)),
			safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }, { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }, { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }, { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
			generationConfig: this.transformConfig(req),
			...this.transformTools(req),
		};
	}

	private transformConfig(req: any) {
		const fieldsMap: Record<string, string> = { max_tokens: 'maxOutputTokens', n: 'candidateCount', stop: 'stopSequences', temperature: 'temperature', top_p: 'topP' };
		const cfg: any = {};
		for (const key in fieldsMap) if (req[key] !== undefined) cfg[fieldsMap[key]] = req[key];
		if (req.response_format?.type === 'json_object') cfg.responseMimeType = 'application/json';
		return cfg;
	}

	private async transformMessages(messages: any[]) {
		if (!messages) return {};
		const contents: any[] = [];
		let system_instruction;
		for (const item of messages) {
			const role = item.role === 'assistant' ? 'model' : item.role;
			const parts = item.content ? [{ text: item.content }] : [];
			if (role === 'system') {
				system_instruction = { parts };
				continue;
			}
			contents.push({ role, parts });
		}
		return { system_instruction, contents };
	}

	private transformTools(req: any) {
		if (!req.tools) return {};
		return { tools: [{ function_declarations: req.tools.map((t: any) => t.function) }] };
	}

	private processCompletionsResponse(data: any, model: string, id: string) {
		const reasonsMap: Record<string, string> = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter' };
		const transformCandidatesMessage = (cand: any) => ({
			index: cand.index || 0,
			message: { role: 'assistant', content: cand.content?.parts?.[0]?.text || null },
			finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
		});
		const choices = data.candidates ? data.candidates.map(transformCandidatesMessage) : [];
		return JSON.stringify({
			id,
			choices,
			created: Math.floor(Date.now() / 1000),
			model: model,
			object: 'chat.completion',
			usage: data.usageMetadata,
		});
	}
    
	async handleApiKeys(request: Request): Promise<Response> {
		try {
			const { keys } = (await request.json()) as { keys: string[] };
			if (!Array.isArray(keys) || keys.length === 0) return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			for (const key of keys) await this.ctx.storage.sql.exec('INSERT OR IGNORE INTO api_keys (api_key) VALUES (?)', key);
			console.log(`[LOG] Admin: Successfully added/ignored ${keys.length} keys.`);
			return new Response(JSON.stringify({ message: 'API密钥添加成功。' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
		} catch (error: any) {
			console.error('[ERROR] handleApiKeys failed:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		}
	}

	async handleDeleteApiKeys(request: Request): Promise<Response> {
		try {
			const { keys } = (await request.json()) as { keys: string[] };
			if (!Array.isArray(keys) || keys.length === 0) return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			const placeholders = keys.map(() => '?').join(',');
			await this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE api_key IN (${placeholders})`, ...keys);
			console.log(`[LOG] Admin: Deleted ${keys.length} keys.`);
			return new Response(JSON.stringify({ message: 'API密钥删除成功。' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
		} catch (error: any) {
			console.error('[ERROR] handleDeleteApiKeys failed:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		}
	}

	async handleApiKeysCheck(): Promise<Response> {
		try {
			console.log("[LOG] Admin: Starting API keys check.");
			const { results } = await this.ctx.storage.sql.exec('SELECT api_key FROM api_keys');
			const keys = results ? results.map((r: any) => r.api_key) : [];
			console.log(`[LOG] Admin: Found ${keys.length} keys to check.`);
			const checkResults = await Promise.all(
				keys.map(async (key: string) => {
					try {
						const response = await fetch(`${BASE_URL}/${API_VERSION}/models?key=${key}`);
						return { key, valid: response.ok, error: response.ok ? null : await response.text() };
					} catch (e: any) {
						return { key, valid: false, error: e.message };
					}
				})
			);

			const invalidKeys = checkResults.filter(r => !r.valid).map(r => r.key);
			if (invalidKeys.length > 0) {
				console.log(`[LOG] Admin: Found ${invalidKeys.length} invalid keys. Deleting them...`);
				const placeholders = invalidKeys.map(() => '?').join(', ');
				this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE api_key IN (${placeholders})`, ...invalidKeys);
			} else {
				console.log("[LOG] Admin: All keys are valid.");
			}
			return new Response(JSON.stringify(checkResults), { headers: { 'Content-Type': 'application/json' } });
		} catch (error: any) {
			console.error('[ERROR] handleApiKeysCheck failed:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		}
	}

	async getAllApiKeys(): Promise<Response> {
		try {
			console.log("[LOG] Admin: Fetching all API keys.");
			const { results } = await this.ctx.storage.sql.exec('SELECT api_key FROM api_keys');
			const keys = results ? results.map((r: any) => r.api_key as string) : [];
			console.log(`[LOG] Admin: Found ${keys.length} keys.`);
			return new Response(JSON.stringify({ keys }), { headers: { 'Content-Type': 'application/json' } });
		} catch (error: any) {
			console.error('[ERROR] getAllApiKeys failed:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		}
	}
    
	private async getRandomApiKey(): Promise<string | null> {
		try {
			console.log("[LOG] Executing SQL to get a random key...");
			const statement = this.ctx.storage.sql.exec('SELECT api_key FROM api_keys ORDER BY RANDOM() LIMIT 1');
			const result = await statement.getFirstRow();
			console.log("[LOG] SQL query completed.");

			if (result && result.api_key && typeof result.api_key === 'string') {
				const key = result.api_key;
				console.log(`[LOG] Successfully retrieved API Key (truncated): ...${key.slice(-4)}`);
				return key;
			} else {
				console.warn("[LOG] SQL query did not return a valid key. Full result:", JSON.stringify(result));
				return null;
			}
		} catch (error: any) {
			console.error("[FATAL] CRITICAL - Failed to execute SQL query to get random API key.", "Error:", error, "Stack:", error.stack);
			return null;
		}
	}
}
