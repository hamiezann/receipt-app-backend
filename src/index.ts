import { Hono } from 'hono';
import { sign, jwt } from 'hono/jwt';
import { prettyJSON } from 'hono/pretty-json';
import authRouter from './routes/auth';
import receiptsRouter from './routes/receipts';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';

type Bindings = {
	DB: D1Database;
	R2: R2Bucket;
	JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(prettyJSON());
// app.use('*', cors());
app.use(
	'*',
	cors({
		origin: ['https://968115be.x3ra.pages.dev', 'http://localhost:5173'],
		allowHeaders: ['Content-Type', 'Authorization'],
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		credentials: true,
	}),
);
app.get('/', (c) => c.text('Xann Receipt App | 2026'));

// protect all routes 'api' with jwt
const authMiddleware = (c: any, next: any) => {
	return jwt({
		secret: c.env.JWT_SECRET,
		alg: 'HS256',
	})(c, next);
};
// app.use('/api/**', authMiddleware);

const routes = app.route('/auth', authRouter).route('/api/receipts', receiptsRouter);

app.notFound((c) => c.json({ message: 'Not found', ok: false }, 404));
app.onError((err, c) => {
	// 1. Gather detailed metadata
	const errorLog = {
		time: new Date().toISOString(),
		method: c.req.method,
		url: c.req.url,
		status: err instanceof HTTPException ? err.status : 500,
		message: err.message,
		// stack: err.stack, // Optional: uncomment for full stack traces
		cause: err.cause, // Captures the original error if provided
		headers: c.req.header(),
	};

	// 2. Log to server console with clear formatting
	console.error('--- ERROR REPORT ---');
	console.table(errorLog);
	if (err.stack) console.error(err.stack);
	console.error('--------------------');

	// 3. Return response to client
	if (err instanceof HTTPException) {
		return err.getResponse();
	}

	return c.json(
		{
			success: false,
			message: 'Internal Server Error',
			traceId: crypto.randomUUID(), // Useful for matching client logs to server logs
		},
		500,
	);
});

export type AppType = typeof routes;

export default app;
