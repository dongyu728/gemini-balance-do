import { DurableObject } from 'cloudflare:workers';
import { isAdminAuthenticated } from './auth';

interface ProcessResult {
    status: 'success' | 'error';
    data?: any;
    error?: string;
    timestamp: number;
    processingTime: number;
}

class HttpError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = this.constructor.name;
        this.status = status;
    }
}

const fixCors = ({ headers, status, statusText }: { headers?: HeadersInit; status?: number; statusText?: string }) => {
    const newHeaders = new Headers(headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    return { headers: newHeaders, status, statusText };
};

const handleOPTIONS = async () => {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': '*',
            'Access-Control-Allow-Headers': '*',
        },
    });
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
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS request_results (
                request_id TEXT PRIMARY KEY,
                result_json TEXT,
                status TEXT,
                created_at INTEGER,
                expires_at INTEGER
            )
        `);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        
        // 处理结果查询请求
        if (url.pathname.startsWith('/internal/result/')) {
            const requestId = url.pathname.split('/').pop();
            return this.handleResultQuery(requestId || '');
        }
        
        // 异步处理请求
        if (request.headers.get('x-async-request') === 'true') {
            const requestId = request.headers.get('x-request-id');
            return this.handleAsyncProcessing(request, requestId || '');
        }
        
        // 原有同步处理逻辑
        try {
            const pathname = url.pathname;

            // 静态资源直接放行
            if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
                return new Response('', { status: 204 });
            }

            // 管理 API 权限校验（使用 HOME_ACCESS_KEY）
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

            // OpenAI compatible routes
            if (
                pathname.endsWith('/chat/completions') ||
                pathname.endsWith('/completions') ||
                pathname.endsWith('/embeddings') ||
                pathname.endsWith('/models')
            ) {
                return this.handleOpenAI(request);
            }

            // Direct Gemini proxy (original logic from the file)
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
            
            return new Response("Route not found.", { status: 404 });

        } catch (e: any) {
            console.error("Caught Unhandled Exception in Durable Object fetch:", e);
            const errorResponse = {
                error: {
                    message: e.message || "An unexpected internal error occurred in the durable object.",
                    type: "durable_object_internal_error",
                    stack: e.stack,
                },
            };
            return new Response(JSON.stringify(errorResponse), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...fixCors({}).headers },
            });
        }
    }

    private async handleAsyncProcessing(request: Request, requestId: string): Promise<Response> {
        try {
            console.log(`[${requestId}] Starting async processing`);
            
            const startTime = Date.now();
            const geminiResponse = await this.processWithGuaranteedFormat(request);
            
            const responseText = await geminiResponse.text();
            let resultData;
            
            try {
                resultData = JSON.parse(responseText);
            } catch {
                resultData = {
                    content: responseText,
                    raw_response: responseText
                };
            }
            
            const processingTime = Date.now() - startTime;
            
            const result: ProcessResult = {
                status: geminiResponse.ok ? 'success' : 'error',
                data: resultData,
                error: geminiResponse.ok ? undefined : `Gemini API error: ${geminiResponse.status}`,
                timestamp: Date.now(),
                processingTime
            };
            
            await this.storeResult(requestId, result);
            
            console.log(`[${requestId}] Async processing completed in ${processingTime}ms`);
            
            return new Response(JSON.stringify({ status: 'completed' }), { status: 200 });
            
        } catch (error) {
            console.error(`[${requestId}] Async processing failed:`, error);
            
            const errorResult: ProcessResult = {
                status: 'error',
                error: error instanceof Error ? error.message : 'Unknown processing error',
                timestamp: Date.now(),
                processingTime: 0
            };
            
            await this.storeResult(requestId, errorResult);
            
            return new Response(JSON.stringify({ status: 'error' }), { status: 500 });
        }
    }

    private async processWithGuaranteedFormat(request: Request): Promise<Response> {
        const apiKey = await this.getValidApiKey();
        if (!apiKey) {
            throw new Error('No valid API keys available');
        }
        
        const url = new URL(request.url);
        const targetUrl = `https://generativelanguage.googleapis.com${url.pathname}${url.search}`;
        
        const headers = new Headers({
            'x-goog-api-key': apiKey,
            'x-goog-api-client': API_CLIENT,
            'Content-Type': 'application/json'
        });
        
        const response = await fetch(targetUrl, {
            method: request.method,
            headers: headers,
            body: await request.text()
        });
        
        return await this.validateAndStandardizeResponse(response);
    }

    private async validateAndStandardizeResponse(response: Response): Promise<Response> {
        if (!response.ok) {
            return response;
        }
        
        const responseText = await response.text();
        
        try {
            const data = JSON.parse(responseText);
            const standardizedData = this.ensureOpenAICompatibility(data);
            
            return new Response(JSON.stringify(standardizedData), {
                status: response.status,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
            
        } catch {
            const structuredResponse = {
                choices: [{
                    message: {
                        role: 'assistant',
                        content: responseText
                    },
                    finish_reason: 'stop'
                }],
                usage: {
                    prompt_tokens: 0,
                    completion_tokens: Math.ceil(responseText.length / 4),
                    total_tokens: Math.ceil(responseText.length / 4)
                }
            };
            
            return new Response(JSON.stringify(structuredResponse), {
                status: response.status,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
    }

    private ensureOpenAICompatibility(data: any): any {
        if (!data.choices || !Array.isArray(data.choices)) {
            data.choices = [{
                message: {
                    role: 'assistant',
                    content: typeof data === 'string' ? data : JSON.stringify(data)
                },
                finish_reason: 'stop'
            }];
        }
        
        data.choices.forEach((choice: any, index: number) => {
            if (!choice.message) {
                choice.message = {
                    role: 'assistant',
                    content: `Response ${index + 1}`
                };
            }
            if (!choice.message.role) {
                choice.message.role = 'assistant';
            }
            if (!choice.message.content) {
                choice.message.content = '';
            }
            if (!choice.finish_reason) {
                choice.finish_reason = 'stop';
            }
        });
        
        if (!data.usage) {
            data.usage = {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            };
        }
        
        return data;
    }

    private async storeResult(requestId: string, result: ProcessResult): Promise<void> {
        await this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO request_results 
             (request_id, result_json, status, created_at, expires_at) 
             VALUES (?, ?, ?, ?, ?)`,
            requestId,
            JSON.stringify(result),
            result.status,
            Date.now(),
            Date.now() + (24 * 60 * 60 * 1000)
        );
    }

    private async handleResultQuery(requestId: string): Promise<Response> {
        const result = await this.ctx.storage.sql
            .exec('SELECT result_json FROM request_results WHERE request_id = ? AND expires_at > ?', 
                  requestId, Date.now())
            .first<{ result_json: string }>();
        
        if (!result) {
            return new Response(JSON.stringify({
                error: 'Result not found or expired'
            }), { status: 404 });
        }
        
        try {
            const resultData = JSON.parse(result.result_json);
            return new Response(JSON.stringify(resultData), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        } catch {
            return new Response(JSON.stringify({
                error: 'Invalid result format'
            }), { status: 500 });
        }
    }

    private async getValidApiKey(): Promise<string | null> {
        const maxRetries = 3;
        
        for (let i = 0; i < maxRetries; i++) {
            const apiKey = await this.getRandomApiKey();
            if (!apiKey) continue;
            
            const isValid = await this.validateApiKey(apiKey);
            if (isValid) return apiKey;
            
            await this.ctx.storage.sql.exec(
                'DELETE FROM api_keys WHERE api_key = ?',
                apiKey
            );
        }
        
        return null;
    }

    private async validateApiKey(apiKey: string): Promise<boolean> {
        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
                { method: 'GET' }
            );
            return response.ok;
        } catch {
            return false;
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

    private async forwardRequestWithLoadBalancing(targetUrl: string, request: Request): Promise<Response> {
        try {
            const apiKey = await this.getRandomApiKey();
            if (!apiKey) {
                return new Response('No API keys configured in the load balancer.', { status: 500 });
            }
            let headers = new Headers();
            headers.set('x-goog-api-key', apiKey);

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
            const { models } = JSON.parse(await response.text());
            responseBody = JSON.stringify(
                {
                    object: 'list',
                    data: models.map(({ name }: any) => ({
                        id: name.replace('models/', ''),
                        object: 'model',
                        created: 0,
                        owned_by: '',
                    })),
                },
                null,
                '  '
            );
        }
        return new Response(responseBody, fixCors(response));
    }

    async handleEmbeddings(req: any, apiKey: string) {
        const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-004';

        if (typeof req.model !== 'string') {
            throw new HttpError('model is not specified', 400);
        }

        let model;
        if (req.model.startsWith('models/')) {
            model = req.model;
        } else {
            if (!req.model.startsWith('gemini-')) {
                req.model = DEFAULT_EMBEDDINGS_MODEL;
            }
            model = 'models/' + req.model;
        }

        if (!Array.isArray(req.input)) {
            req.input = [req.input];
        }

        const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
            method: 'POST',
            headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                requests: req.input.map((text: string) => ({
                    model,
                    content: { parts: { text } },
                    outputDimensionality: req.dimensions,
                })),
            }),
        });

        let responseBody: BodyInit | null = response.body;
        if (response.ok) {
            const { embeddings } = JSON.parse(await response.text());
            responseBody = JSON.stringify(
                {
                    object: 'list',
                    data: embeddings.map(({ values }: any, index: number) => ({
                        object: 'embedding',
                        index,
                        embedding: values,
                    })),
                    model: req.model,
                },
                null,
                '  '
            );
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

        const TASK = req.stream ? 'streamGenerateContent' : 'generateContent';
        let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
        if (req.stream) {
            url += '?alt=sse';
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        });

        let responseBody: BodyInit | null = response.body;
        if (response.ok) {
            let id = 'chatcmpl-' + this.generateId();
            const shared = {};

            if (req.stream) {
                responseBody = response
                    .body!.pipeThrough(new TextDecoderStream())
                    .pipeThrough(
                        new TransformStream({
                            transform: this.parseStream,
                            flush: this.parseStreamFlush,
                            buffer: '',
                            shared,
                        } as any)
                    )
                    .pipeThrough(
                        new TransformStream({
                            transform: this.toOpenAiStream,
                            flush: this.toOpenAiStreamFlush,
                            streamIncludeUsage: req.stream_options?.include_usage,
                            model,
                            id,
                            last: [],
                            shared,
                        } as any)
                    )
                    .pipeThrough(new TextEncoderStream());
            } else {
                let body: any = await response.text();
                try {
                    body = JSON.parse(body);
                    if (!body.candidates) {
                        throw new Error('Invalid completion object');
                    }
                } catch (err) {
                    console.error('Error parsing response:', err);
                    return new Response(JSON.stringify({ error: 'Failed to parse response' }), {
                        ...fixCors(response),
                        status: 500,
                    });
                }
                responseBody = this.processCompletionsResponse(body, model, id);
            }
        }
        return new Response(responseBody, fixCors(response));
    }

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

        const obj = {
            id,
            choices: data.candidates.map(transformCandidatesMessage),
            created: Math.floor(Date.now() / 1000),
            model: data.modelVersion ?? model,
            object: 'chat.completion',
            usage: data.usageMetadata && {
                completion_tokens: data.usageMetadata.candidatesTokenCount,
                prompt_tokens: data.usageMetadata.promptTokenCount,
                total_tokens: data.usageMetadata.totalTokenCount,
            },
        };

        return JSON.stringify(obj);
    }

    private parseStream(this: any, chunk: string, controller: any) {
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop()!;

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.substring(6);
                if (data.startsWith('{')) {
                    controller.enqueue(JSON.parse(data));
                }
            }
        }
    }

    private parseStreamFlush(this: any, controller: any) {
        if (this.buffer) {
            try {
                controller.enqueue(JSON.parse(this.buffer));
            } catch (e) {
                console.error('Error parsing remaining buffer:', e);
            }
        }
    }

    private toOpenAiStream(this: any, line: any, controller: any) {
        try {
            const reasonsMap: Record<string, string> = {
                STOP: 'stop',
                MAX_TOKENS: 'length',
                SAFETY: 'content_filter',
                RECITATION: 'content_filter',
            };

            const { candidates, usageMetadata } = line;
            if (usageMetadata) {
                this.shared.usage = {
                    completion_tokens: usageMetadata.candidatesTokenCount,
                    prompt_tokens: usageMetadata.promptTokenCount,
                    total_tokens: usageMetadata.totalTokenCount,
                };
            }

            if (candidates) {
                for (const cand of candidates) {
                    if (!cand || !cand.content || !cand.content.parts) {
                        console.warn(`[LOG] DO: Stream Transform skipped a candidate with missing content/parts: ${JSON.stringify(cand)}`);
                        continue;
                    }

                    const { index, content, finishReason } = cand;
                    const { parts } = content;
                    const text = parts.map((p: any) => p.text).join('');

                    if (this.last[index] === undefined) {
                        this.last[index] = '';
                    }

                    const lastText = this.last[index] || '';
                    let delta = '';

                    if (text.startsWith(lastText)) {
                        delta = text.substring(lastText.length);
                    } else {
                        console.warn(`[LOG] DO: Stream delta calculation mismatch. lastText: "${lastText}", newText: "${text}"`);
                        let i = 0;
                        while (i < text.length && i < lastText.length && text[i] === lastText[i]) {
                            i++;
                        }
                        delta = text.substring(i);
                    }

                    this.last[index] = text;

                    const obj = {
                        id: this.id,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: this.model,
                        choices: [
                            {
                                index,
                                delta: { content: delta },
                                finish_reason: reasonsMap[finishReason] || finishReason,
                            },
                        ],
                    };
                    controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
                }
            }
        } catch (e: any) {
            console.error("[LOG] DO: CRITICAL ERROR inside toOpenAiStream transform! This caused the stream to crash.", e);
            const errorObj = {
                error: {
                    message: `Stream transformation failed: ${e.message}`,
                    type: 'stream_transform_error',
                }
            };
            controller.enqueue(`data: ${JSON.stringify(errorObj)}\n\n`);
            controller.terminate();
        }
    }

    private toOpenAiStreamFlush(this: any, controller: any) {
        if (this.streamIncludeUsage && this.shared.usage) {
            const obj = {
                id: this.id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: this.model,
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: 'stop',
                    },
                ],
                usage: this.shared.usage,
            };
            controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
        }
        controller.enqueue('data: [DONE]\n\n');
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

            return new Response(JSON.stringify({ message: 'API密钥添加成功。' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (error: any) {
            console.error('处理API密钥失败:', error);
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

            return new Response(JSON.stringify({ message: 'API密钥删除成功。' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (error: any) {
            console.error('删除API密钥失败:', error);
            return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    async handleApiKeysCheck(): Promise<Response> {
        try {
            const results = await this.ctx.storage.sql.exec('SELECT api_key FROM api_keys').raw<any>();
            const keys = Array.from(results);

            const checkResults = await Promise.all(
                keys.map(async (key) => {
                    try {
                        const response = await fetch(`${BASE_URL}/${API_VERSION}/models?key=${key}`);
                        return { key, valid: response.ok, error: response.ok ? null : await response.text() };
                    } catch (e: any) {
                        return { key, valid: false, error: e.message };
                    }
                })
            );

            const invalidKeys = checkResults.filter((result) => !result.valid).map((result) => result.key);
            if (invalidKeys.length > 0) {
                console.log('InvalidKeys: ', JSON.stringify(invalidKeys));
                const placeholders = invalidKeys.map(() => '?').join(', ');
                const statement = `DELETE FROM api_keys WHERE api_key IN (${placeholders})`;
                this.ctx.storage.sql.exec(statement, ...invalidKeys);
                console.log(`移除了 ${invalidKeys.length} 个无效的API密钥。`);
            }

            return new Response(JSON.stringify(checkResults), {
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (error: any) {
            console.error('检查API密钥失败:', error);
            return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    async getAllApiKeys(): Promise<Response> {
        try {
            const results = await this.ctx.storage.sql.exec('SELECT * FROM api_keys').raw<any>();
            const keys = Array.from(results);
            return new Response(JSON.stringify({ keys }), {
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (error: any) {
            console.error('获取API密钥失败:', error);
            return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    private async getRandomApiKey(): Promise<string | null> {
        try {
            const result = await this.ctx.storage.sql
                .exec('SELECT api_key FROM api_keys ORDER BY RANDOM() LIMIT 1')
                .first<{ api_key: string }>();
            
            return result ? result.api_key : null;
        } catch (error) {
            console.error('获取随机API密钥失败:', error);
            return null;
        }
    }