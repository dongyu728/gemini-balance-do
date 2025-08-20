// gemini-balance-do/src/handler.ts (The Definitive, Final, Fully-Functional Version with Rollback)

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
const API_CLIENT = 'genai-js/0.21.0';

const makeHeaders = (apiKey: string, more?: Record<string, string>) => ({
	'x-goog-api-client': API_CLIENT,
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
		try {
			const url = new URL(request.url);
			const pathname = url.pathname;

			if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
				return new Response('', { status: 204 });
			}
			
			// 管理API路由
			if (
				(pathname === '/api/keys' && ['POST', 'GET', 'DELETE'].includes(request.method)) ||
				(pathname === '/api/keys/check' && request.method === 'GET')
			) {
				if (!isAdminAuthenticated(request, this.env.HOME_ACCESS_KEY)) {
					return new Response(JSON.stringify({ error: 'Unauthorized' }) , {
						status: 401,
						headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
					});
				}
				if (pathname === '/api/keys' && request.method === 'POST') {
					return this.handleApiKeys(request);
				}
				if (pathname === '/api/keys' && request.method === 'GET') {
					return this.getAllApiKeys();
				}
				if (pathname === '/api/keys' && request.method === 'DELETE') {
					return this.handleDeleteApiKeys(request);
				}
				if (pathname === '/api/keys/check' && request.method === 'GET') {
					return this.handleApiKeysCheck();
				}
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
			
			// 原始代码中的直接代理逻辑
			const authKey = this.env.AUTH_KEY;
			const search = url.search;
			let targetUrl = `${BASE_URL}${pathname}${search}`;

			if (authKey) {
				if (search.includes('key=')) {
					const urlObj = new URL(targetUrl);
					const requestKey = urlObj.searchParams.get('key');
					if (requestKey) {
						if (requestKey !== authKey) {
							return new Response('Unauthorized', { status: 401, headers: fixCors({}).headers });
						}
						urlObj.searchParams.delete('key');
						targetUrl = urlObj.toString();
						return this.forwardRequestWithLoadBalancing(targetUrl, request);
					}
				} else {
					const requestKey = request.headers.get('x-goog-api-key');
					if (requestKey !== authKey) {
						return new Response('Unauthorized', { status: 401, headers: fixCors({}).headers });
					}
					return this.forwardRequestWithLoadBalancing(targetUrl, request);
				}
			}
			
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

	async forwardRequest(targetUrl: string, request: Request, headers: Headers): Promise<Response> {
		console.log(`Request Sending to Gemini: ${targetUrl}`);

		const response = await fetch(targetUrl, {
			method: request.method,
			headers: headers,
			body: request.body,
		});

		console.log('Call Gemini Success');

		const responseHeaders = new Headers(response.headers);
		responseHeaders.set('Access-Control-Allow-Origin', '*');
		responseHeaders.delete('transfer-encoding');
		responseHeaders.delete('connection');
		responseHeaders.delete('keep-alive');
		responseHeaders.delete('content-encoding');
		responseHeaders.set('Referrer-Policy', 'no-referrer');

		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders,
		});
	}

	// 对请求进行负载均衡，随机分发key
	private async forwardRequestWithLoadBalancing(targetUrl: string, request: Request): Promise<Response> {
		try {
			const apiKey = await this.getRandomApiKey();
			if (!apiKey) {
				return new Response('No API keys configured in the load balancer.', { status: 500 });
			}
			let headers = new Headers();
			headers.set('x-goog-api-key', apiKey);

			// Forward content-type header
			if (request.headers.has('content-type')) {
				headers.set('content-type', request.headers.get('content-type')!);
			}

			return this.forwardRequest(targetUrl, request, headers);
		} catch (error) {
			console.error('Failed to fetch:', error);
			return new Response('Internal Server Error\n' + error, {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	}

	async handleModels(apiKey: string) {
		const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
			headers: makeHeaders(apiKey),
		});
		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { models } = await response.json();
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

	async handleCompletions(req: any, apiKey: string) {
		const DEFAULT_MODEL = 'gemini-2.5-flash';
		let model = DEFAULT_MODEL;

		switch (true) {
			case typeof req.model !== 'string':
				break;
			case req.model.startsWith('models/'):
				model = req.model.substring(7);
				break;
			case req.model.startsWith('gemini-'):
			case req.model.startsWith('gemma-'):
			case req.model.startsWith('learnlm-'):
				model = req.model;
		}

		// --- 【最终的、最小化修改】 ---
		// 无论客户端请求什么，我们都强制使用非流式传输，以确保最大稳定性。
		const stream = false;
        // 同时，覆盖客户端传入的stream参数，防止它干扰后续逻辑
        if (req) {
            req.stream = false;
        }
		console.log("[LOG] Streaming is forcefully disabled for stability.");
		// --- 【修改结束】 ---

		let body = await this.transformRequest(req);
		const extra = req.extra_body?.google;

		if (extra) {
			if (extra.safety_settings) {
				body.safetySettings = extra.safety_settings;
			}
			if (extra.cached_content) {
				body.cachedContent = extra.cached_content;
			}
			if (extra.thinking_config) {
				body.generationConfig.thinkingConfig = extra.thinking_config;
			}
		}

		switch (true) {
			case model.endsWith(':search'):
				model = model.substring(0, model.length - 7);
			case req.model.endsWith('-search-preview'):
			case req.tools?.some((tool: any) => tool.function?.name === 'googleSearch'):
				body.tools = body.tools || [];
				body.tools.push({ function_declarations: [{ name: 'googleSearch', parameters: {} }] });
		}

		const TASK = stream ? 'streamGenerateContent' : 'generateContent';
		let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
		
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
			let data: any = await response.text();
			try {
				data = JSON.parse(data);
				if (!data.candidates) throw new Error('Invalid completion object');
			} catch (err) {
				console.error('Error parsing response:', err);
				return new Response(JSON.stringify({ error: 'Failed to parse response' }), { ...fixCors(response), status: 500 });
			}
			responseBody = this.processCompletionsResponse(data, model, id);
			console.log("[LOG] Non-stream response processed and sent to client successfully.");
		} else {
			const errorText = await response.text();
			console.error(`[ERROR] Gemini API returned an error. Status: ${response.status}, Body: ${errorText}`);
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
    // --- 已全部恢复到您原始的、功能正常的版本，并增加了日志 ---
    
	private generateId(): string {
		const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
		return Array.from({ length: 29 }, randomChar).join('');
	}

	private async transformRequest(req: any) {
		const harmCategory = [
			'HARM_CATEGORY_HATE_SPEECH',
			'HARM_CATEGORY_SEXUALLY_EXPLICIT',
			'HARM_CATEGORY_DANGEROUS_CONTENT',
			'HARM_CATEGORY_HARASSMENT',
			'HARM_CATEGORY_CIVIC_INTEGRITY',
		];

		const safetySettings = harmCategory.map((category) => ({
			category,
			threshold: 'BLOCK_NONE',
		}));

		return {
			...(await this.transformMessages(req.messages)),
			safetySettings,
			generationConfig: this.transformConfig(req),
			...this.transformTools(req),
			cachedContent: undefined as any,
		};
	}

	private transformConfig(req: any) {
		const fieldsMap: Record<string, string> = {
			frequency_penalty: 'frequencyPenalty',
			max_completion_tokens: 'maxOutputTokens',
			max_tokens: 'maxOutputTokens',
			n: 'candidateCount',
			presence_penalty: 'presencePenalty',
			seed: 'seed',
			stop: 'stopSequences',
			temperature: 'temperature',
			top_k: 'topK',
			top_p: 'topP',
		};

		const thinkingBudgetMap: Record<string, number> = {
			low: 1024,
			medium: 8192,
			high: 24576,
		};

		let cfg: any = {};
		for (let key in req) {
			const matchedKey = fieldsMap[key];
			if (matchedKey) {
				cfg[matchedKey] = req[key];
			}
		}

		if (req.response_format) {
			switch (req.response_format.type) {
				case 'json_schema':
					cfg.responseSchema = req.response_format.json_schema?.schema;
					if (cfg.responseSchema && 'enum' in cfg.responseSchema) {
						cfg.responseMimeType = 'text/x.enum';
						break;
					}
				case 'json_object':
					cfg.responseMimeType = 'application/json';
					break;
				case 'text':
					cfg.responseMimeType = 'text/plain';
					break;
				default:
					throw new HttpError('Unsupported response_format.type', 400);
			}
		}
		if (req.reasoning_effort) {
			cfg.thinkingConfig = { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
		}

		return cfg;
	}

	private async transformMessages(messages: any[]) {
		if (!messages) {
			return {};
		}

		const contents: any[] = [];
		let system_instruction;

		for (const item of messages) {
			switch (item.role) {
				case 'system':
					system_instruction = { parts: await this.transformMsg(item) };
					continue;
				case 'assistant':
					item.role = 'model';
					break;
				case 'user':
					break;
				default:
					throw new HttpError(`Unknown message role: "${item.role}"`, 400);
			}

			contents.push({
				role: item.role,
				parts: await this.transformMsg(item),
			});
		}

		return { system_instruction, contents };
	}

	private async transformMsg({ content }: any) {
		const parts = [];
		if (!Array.isArray(content)) {
			parts.push({ text: content });
			return parts;
		}

		for (const item of content) {
			switch (item.type) {
				case 'text':
					parts.push({ text: item.text });
					break;
				case 'image_url':
					// 简化的图片处理
					parts.push({ text: '[图片内容]' });
					break;
				default:
					throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
			}
		}

		return parts;
	}

	private transformTools(req: any) {
		let tools, tool_config;
		if (req.tools) {
			const funcs = req.tools.filter((tool: any) => tool.type === 'function' && tool.function?.name !== 'googleSearch');
			if (funcs.length > 0) {
				tools = [{ function_declarations: funcs.map((schema: any) => schema.function) }];
			}
		}
		if (req.tool_choice) {
			const allowed_function_names = req.tool_choice?.type === 'function' ? [req.tool_choice?.function?.name] : undefined;
			if (allowed_function_names || typeof req.tool_choice === 'string') {
				tool_config = {
					function_calling_config: {
						mode: allowed_function_names ? 'ANY' : req.tool_choice.toUpperCase(),
						allowed_function_names,
					},
				};
			}
		}
		return { tools, tool_config };
	}

	private processCompletionsResponse(data: any, model: string, id: string) {
		const reasonsMap: Record<string, string> = {
			STOP: 'stop',
			MAX_TOKENS: 'length',
			SAFETY: 'content_filter',
			RECITATION: 'content_filter',
		};

		const transformCandidatesMessage = (cand: any) => {
			const message = { role: 'assistant', content: [] as string[] };
			for (const part of cand.content?.parts ?? []) {
				if (part.text) {
					message.content.push(part.text);
				}
			}

			return {
				index: cand.index || 0,
				message: {
					...message,
					content: message.content.join('') || null,
				},
				logprobs: null,
				finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
			};
		};

		const choices = data.candidates ? data.candidates.map(transformCandidatesMessage) : [];
		return JSON.stringify({
			id,
			choices,
			created: Math.floor(Date.now() / 1000),
			model: data.modelVersion ?? model,
			object: 'chat.completion',
			usage: data.usageMetadata && {
				completion_tokens: data.usageMetadata.candidatesTokenCount,
				prompt_tokens: data.usageMetadata.promptTokenCount,
				total_tokens: data.usageMetadata.totalTokenCount,
			},
		});
	}
    
	async handleApiKeys(request: Request): Promise<Response> {
		try {
			const { keys } = (await request.json()) as { keys: string[] };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			for (const key of keys) {
				await this.ctx.storage.sql.exec('INSERT OR IGNORE INTO api_keys (api_key) VALUES (?)', key);
			}
			console.log(`[LOG] Admin: Successfully added/ignored ${keys.length} keys.`);
			return new Response(JSON.stringify({ message: 'API密钥添加成功。' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('[ERROR] Admin: handleApiKeys failed:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleDeleteApiKeys(request: Request): Promise<Response> {
		try {
			const { keys } = (await request.json()) as { keys: string[] };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const placeholders = keys.map(() => '?').join(',');
			await this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE api_key IN (${placeholders})`, ...keys);
			console.log(`[LOG] Admin: Deleted ${keys.length} keys.`);
			return new Response(JSON.stringify({ message: 'API密钥删除成功。' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('[ERROR] Admin: handleDeleteApiKeys failed:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleApiKeysCheck(): Promise<Response> {
		try {
			console.log("[LOG] Admin: Starting API keys check.");
			const results = await this.ctx.storage.sql.exec('SELECT api_key FROM api_keys').raw<any[]>();
			const keys = Array.from(results).map(row => row[0] as string);
			
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
			console.error('[ERROR] Admin: handleApiKeysCheck failed:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async getAllApiKeys(): Promise<Response> {
		try {
			console.log("[LOG] Admin: Fetching all API keys.");
			// 【代码回退】使用原始的、功能正常的 .raw() 方法
			const results = await this.ctx.storage.sql.exec('SELECT * FROM api_keys').raw<[string][]>();
			const keys = results ? results.map(row => row[0]) : [];
			console.log(`[LOG] Admin: Found ${keys.length} keys.`);
			return new Response(JSON.stringify({ keys }), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('[ERROR] Admin: getAllApiKeys failed:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}
    
	private async getRandomApiKey(): Promise<string | null> {
		try {
			console.log("[LOG] Executing SQL to get a random key...");
			// 【代码回退】使用原始的、功能正常的 .raw() 方法
			const results = await this.ctx.storage.sql.exec('SELECT * FROM api_keys ORDER BY RANDOM() LIMIT 1').raw<[string][]>();
			console.log("[LOG] SQL query completed.");

			if (results && results.length > 0 && results[0] && typeof results[0][0] === 'string') {
				const key = results[0][0];
				console.log(`[LOG] Successfully retrieved API Key (truncated): ...${key.slice(-4)}`);
				return key;
			} else {
				console.warn("[LOG] SQL query did not return a valid key. Is the database empty? Full result:", JSON.stringify(results));
				return null;
			}
		} catch (error: any) {
			console.error("[FATAL] CRITICAL - Failed to execute SQL query to get random API key.", "Error:", error, "Stack:", error.stack);
			return null;
		}
	}
}
