import { AuthServices } from 'src/services/auth-services';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { HTTPException } from 'hono/http-exception';

type Bindings = {
	DB: D1Database;
	JWT_SECRET: string;
	RESEND_API_KEY: string;
	xreceipt_app: KVNamespace;
	APP_ROOT_URL: string;
};

const auth = new Hono<{ Bindings: Bindings }>();
const authTools = new AuthServices();

// register route
auth.post('/register', async (c) => {
	const { email, password } = await c.req.json();
	const tempOtp = Math.floor(Math.random() * 1000000)
		.toString()
		.padStart(6, '0');
	const isRegistered = await c.env.DB.prepare('SELECT EXISTS(SELECT 1 FROM users WHERE email = ?);').bind(email).run();
	if (!isRegistered) {
		throw new HTTPException(400, { message: `Email already in use: ${email}` });
	}
	await c.env.xreceipt_app.put(email, JSON.stringify({ tempOtp, password }), { expirationTtl: 300 });
	const fromEmail = 'X3RA <onboarding@xcorporation.uk>'; // Use resend.dev for testing
	const subject = '🔐 Your X3RA Verification Code';

	const htmlTemplate = `
    <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #333;">Welcome to X3RA!</h2>
        <p>Please use the code below to verify your email address. This code will expire in 5 minutes.</p>
        <div style="background: #f4f4f4; padding: 10px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px; color: #007bff;">
            ${tempOtp}
        </div>
        <p style="font-size: 12px; color: #777; margin-top: 20px;">If you didn't request this code, you can safely ignore this email.</p>
    </div>
`;
	const response = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: fromEmail,
			to: [email],
			subject: subject,
			html: htmlTemplate, // Using 'html' instead of 'text' for a better UI
		}),
	});

	return c.json({ message: 'OTP sent to email!' });
});

// verify tac route
auth.post('/verify-otp', async (c) => {
	const { code, email } = await c.req.json();
	const storedOTP = await c.env.xreceipt_app.get(email);
	if (!storedOTP) {
		return c.json({ error: 'Wrong OTP!' });
	}
	const { tempOtp, password } = JSON.parse(storedOTP);
	if (code !== tempOtp) {
		return c.json({ error: 'Invalid verification code' }, 400);
	}

	const hashedPswd = await authTools.hashPassword(password);
	try {
		await c.env.DB.prepare('INSERT INTO users (email, password, role_id) VALUES (?, ?, ?)').bind(email, hashedPswd, 3).run();
		return c.json({ message: 'User verified and account created' }, 201);
	} catch (e) {
		return c.json({ error: 'User already exists' }, 400);
	}
});

// Login route
auth.post('/login', async (c) => {
	const { email, password } = await c.req.json();
	const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ? AND isActive = TRUE')
		.bind(email)
		.first<{ id: number; password: string }>();
	if (!user) return c.json({ error: 'Invalid credentials' }, 401);

	const isValid = await authTools.verifyPassword(password, user.password);
	if (!isValid) return c.json({ error: 'Invalid credentials' }, 401);

	// UPDATE LATEST LOGIN
	await c.env.DB.prepare('UPDATE users SET latest_login = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run();

	const payload = {
		sub: user.id,
		exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
	};
	const token = await sign(payload, c.env.JWT_SECRET);

	return c.json({ token });
});

// forgot password route : will redirect to forgot password page
auth.post('/forgot-password', async (c) => {
	const { email } = await c.req.json();
	const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();

	if (!user) {
		return c.json({ message: 'If this email exists, a reset link has been sent.' });
	}

	const payload = {
		sub: user.id,
		type: 'password_reset',
		exp: Math.floor(Date.now() / 1000) + 60 * 15, // 15 minutes is safer
	};
	const token = await sign(payload, c.env.JWT_SECRET);

	await c.env.xreceipt_app.put(`reset:${token}`, user.id, { expirationTtl: 900 });
	const rootUrl = 'http://localhost:5173';
	const resetUrl = `${rootUrl}/reset-password?token=${token}`;

	try {
		const fromEmail = 'X3RA <onboarding@xcorporation.uk>'; // Use resend.dev for local testing
		const subject = 'Reset Your X3RA Password';
		const htmlTemplate = `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #333;">Password Reset Request</h2>
                <p>Click the button below to reset your password. This link expires in 15 minutes.</p>
                <a href="${resetUrl}" style="display: inline-block; padding: 10px 20px; background: #007bff; color: #fff; text-decoration: none; border-radius: 5px;">Reset Password</a>
                <p style="font-size: 12px; color: #777; margin-top: 20px;">If you didn't request this, you can safely ignore this email.</p>
            </div>
        `;

		await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: fromEmail,
				to: [email],
				subject: subject,
				html: htmlTemplate,
			}),
		});

		return c.json({ message: 'Reset email sent' });
	} catch (e) {
		throw new HTTPException(500, { message: `Failed to send email` });
	}
});

// reset password route
auth.post('reset-password', async (c) => {
	const { newPassword, token } = await c.req.json();
	const userId = await c.env.xreceipt_app.get(`reset:${token}`);
	if (!userId) {
		return c.json({ message: 'Invalid or expired reset token' }, 400);
	}
	try {
		const hashedPswd = await authTools.hashPassword(newPassword);
		await c.env.DB.prepare('UPDATE users SET password = ? Where Id = ?').bind(hashedPswd, userId).run();
		await c.env.xreceipt_app.delete(`reset:${token}`);
		return c.json({ message: 'User password resetted' }, 201);
	} catch (e) {
		return c.json({ message: `Failed to reset password: ${e}` }, 500);
	}
});

// send reset tac
auth.post('/send-reset-otp', async (c) => {
	const { userId, newPassword } = await c.req.json();
	const temp = await c.env.DB.prepare('SELECT email from users where id = ?').bind(userId).first();
	const email = temp?.toString() as string;

	try {
		const tempOtp = Math.floor(10000 + Math.random() * 900000).toString();
		await c.env.xreceipt_app.put(email, JSON.stringify({ tempOtp, newPassword }), { expirationTtl: 300 });
		const fromEmail = 'X3RA <onboarding@xcorporation.uk>';
		const subject = '🔐 Your X3RA Reset Password Code';

		const htmlTemplate = `
				<div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
					<h2 style="color: #333;">Welcome to X3RA!</h2>
					<p>Please use the code below to reset your password. This code will expire in 5 minutes.</p>
					<div style="background: #f4f4f4; padding: 10px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px; color: #007bff;">
						${tempOtp}
					</div>
					<p style="font-size: 12px; color: #777; margin-top: 20px;">If you didn't request this code, you can safely ignore this email.</p>
				</div>
			`;
		const response = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: fromEmail,
				to: [email],
				subject: subject,
				html: htmlTemplate, // Using 'html' instead of 'text' for a better UI
			}),
		});
	} catch (e) {
		throw new HTTPException(401, { message: `Failed to send reset email: ${e}` });
	}
});

// verify reset tac
auth.post('/verify-reset-otp', async (c) => {
	const { code, email } = await c.req.json();
	const storedOTP = await c.env.xreceipt_app.get(email);
	if (!storedOTP) {
		return c.json({ error: 'Wrong OTP!' });
	}
	const { tempOtp, password } = JSON.parse(storedOTP);
	if (code !== tempOtp) {
		return c.json({ error: 'Invalid verification code' }, 400);
	}

	const hashedPswd = await authTools.hashPassword(password);
	try {
		await c.env.DB.prepare('INSERT INTO users (email, password, role_id) VALUES (?, ?, ?)').bind(email, hashedPswd, 3).run();
		return c.json({ message: 'User verified created' }, 201);
	} catch (e) {
		return c.json({ error: 'User already exists' }, 400);
	}
});

export default auth;
