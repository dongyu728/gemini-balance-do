/*
 * @Author: xieguodong xieguodong@gmail.com
 * @Date: 2025-08-19 13:53:02
 * @LastEditors: xieguodong xieguodong@gmail.com
 * @LastEditTime: 2025-08-20 18:59:21
 * @FilePath: \gemini-balance-do\src\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { Hono } from 'hono';
import { Render } from './render';
import { LoadBalancer } from './handler';
import { getAuthKey } from './auth';
import { getCookie, setCookie } from 'hono/cookie';

const app = new Hono<{ Bindings: Env }>();

// 管理页面访问，校验 HOME_ACCESS_KEY
app.get('/', (c) => {
    const sessionKey = getCookie(c, 'auth-key');
    const authKey = getAuthKey(c.req.raw, sessionKey);
    if (authKey !== c.env.HOME_ACCESS_KEY) {
        return c.html(Render({ isAuthenticated: false, showWarning: false }));
    }
    const showWarning = c.env.HOME_ACCESS_KEY === 'xgd006697'
        || c.env.AUTH_KEY === 'dongyu0728';
    return c.html(Render({ isAuthenticated: true, showWarning }));
});

// 登录接口，校验 HOME_ACCESS_KEY，登录成功后写入 cookie
app.post('/', async (c) => {
    const { key } = await c.req.json();
    if (key === c.env.HOME_ACCESS_KEY) {
        setCookie(c, 'auth-key', key, { maxAge: 60 * 60 * 24 * 30, path: '/' });
        return c.json({ success: true });
    }
    return c.json({ success: false }, 401);
});

// 静态资源放行
app.get('/favicon.ico', async (c) => {
    return c.text('Not found', 404);
});

// 异步处理端点
app.post('/async/process', async (c) => {
    try {
        const id: DurableObjectId = c.env.LOAD_BALANCER.idFromName('loadbalancer');
        const stub = c.env.LOAD_BALANCER.get(id, { locationHint: 'wnam' });
        
        const request = c.req.raw.clone();
        const requestId = generateRequestId();
        
        // 立即返回202接受响应
        const response = new Response(JSON.stringify({
            request_id: requestId,
            status: 'processing',
            message: 'Request is being processed asynchronously',
            check_url: `/async/result/${requestId}`
        }), {
            status: 202,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
        
        // 后台处理（不阻塞响应）
        c.executionCtx.waitUntil((async () => {
            try {
                await stub.fetch(new Request(request.url, {
                    method: 'POST',
                    headers: {
                        ...Object.fromEntries(request.headers),
                        'x-async-request': 'true',
                        'x-request-id': requestId
                    },
                    body: await request.text()
                }));
            } catch (error) {
                console.error(`Background processing failed for ${requestId}:`, error);
            }
        })());
        
        return response;
    } catch (e: any) {
        console.error("Async processing error:", e);
        return c.json({
            error: "Failed to initiate async processing",
            details: e.message
        }, 500);
    }
});

// 结果查询端点
app.get('/async/result/:requestId', async (c) => {
    const requestId = c.req.param('requestId');
    try {
        const id: DurableObjectId = c.env.LOAD_BALANCER.idFromName('loadbalancer');
        const stub = c.env.LOAD_BALANCER.get(id, { locationHint: 'wnam' });
        
        const resultResponse = await stub.fetch(new Request(
            `https://internal/result/${requestId}`,
            { method: 'GET' }
        ));
        
        if (resultResponse.status === 404) {
            return c.json({
                request_id: requestId,
                status: 'processing',
                message: 'Result not ready yet'
            }, 202);
        }
        
        return new Response(resultResponse.body, {
            status: resultResponse.status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    } catch (e: any) {
        console.error(`Result query error for ${requestId}:`, e);
        return c.json({
            error: "Failed to query result",
            details: e.message
        }, 500);
    }
});

// 其它请求转发到 Durable Object
app.all('*', async (c) => {
    try {
        const id: DurableObjectId = c.env.LOAD_BALANCER.idFromName('loadbalancer');
        const stub = c.env.LOAD_BALANCER.get(id, { locationHint: 'wnam' });
        
        // 直接将对Durable Object的调用包裹在try...catch中
        // stub.fetch返回的是一个完整的Response对象，我们应该直接返回它
        // 这样可以确保流式响应等特性被正确处理
        const resp = await stub.fetch(c.req.raw);
        return resp;

    } catch (e: any) {
        // 这个catch块捕获的是与Durable Object通信时发生的罕见错误
        console.error("Fatal Error: Failed to fetch from Durable Object stub.", e);
        
        // 向客户端返回一个结构化的JSON错误
        const errorResponse = {
            error: {
                message: "Failed to communicate with the core processing service. This is a critical error.",
                type: "durable_object_communication_error",
                details: e.message,
            },
        };
        // 使用Hono的.json()方法可以更方便地返回JSON响应
        return c.json(errorResponse, 500);
    }
});

function generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

type Env = {
    LOAD_BALANCER: DurableObjectNamespace<LoadBalancer>;
    AUTH_KEY: string;
    HOME_ACCESS_KEY: string;
    RESULTS_KV: KVNamespace;
};

export default {
    fetch: app.fetch,
};

export { LoadBalancer };