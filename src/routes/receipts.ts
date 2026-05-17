import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { jwt } from 'hono/jwt';
import { CreateReceiptDto, EditReceiptDto, ViewReceiptDto, ViewReceiptType } from 'src/dtos/receipt-dto';
import { AuthServices } from 'src/services/auth-services';
import z from 'zod';

type Bindings = {
	AI: any;
	DB: D1Database;
	R2: R2Bucket;
	JWT_SECRET: string;
	R2_PUBLIC_URL: string;
};

const authTools = new AuthServices();
const receipts = new Hono<{ Bindings: Bindings }>();
const IdParamSchema = z.object({
	id: z.string().regex(/^\d+$/).transform(Number),
});

const AnalyticsQuerySchema = z.object({
	rangeType: z.enum(['all', 'month', 'custom']).default('all'),
	startDate: z.string().optional(), // Expected format: YYYY-MM-DD
	endDate: z.string().optional(), // Expected format: YYYY-MM-DD
	month: z
		.string()
		.regex(/^\d{2}$/)
		.optional(), // Expected format: MM (e.g., "05")
	year: z
		.string()
		.regex(/^\d{4}$/)
		.optional(), // Expected format: YYYY (e.g., "2026")
	category: z.string().optional(), // Filter by a specific category if provided
});

receipts.use('*', async (c, next) => {
	const jwtHandler = jwt({
		secret: c.env.JWT_SECRET,
		alg: 'HS256',
	});
	return jwtHandler(c, next);
});
// backend/src/routes/receipts.ts

// Get all receipts belonging to the user
receipts.get('/getReceipts', async (c) => {
	try {
		const userId = await authTools.getUserId(c);
		const { results } = await c.env.DB.prepare('SELECT * FROM receipts WHERE user_id = ? ORDER BY receipt_date DESC').bind(userId).all();

		// Always return an array to avoid frontend breakdown
		return c.json(results || []);
	} catch (e) {
		return c.json({ error: 'Failed to fetch transactions' }, 500);
	}
});

// get the receipt instances
receipts.get('/id/:id', zValidator('param', IdParamSchema), async (c) => {
	const userId = await authTools.getUserId(c);
	const { id } = c.req.valid('param');

	const query = await c.env.DB.prepare('SELECT * FROM receipts WHERE user_id = ? AND id = ?').bind(userId, id).first();

	if (!query) {
		throw new HTTPException(404, { message: 'No result found' });
	}

	return c.json(query);
});

// add new receipts
receipts.post('/add', zValidator('json', CreateReceiptDto), async (c) => {
	const data = c.req.valid('json');
	const userId = await authTools.getUserId(c);
	try {
		await c.env.DB.prepare(
			'INSERT INTO receipts (store_name, total_amount, currency, receipt_date, category, descriptions, image_ref_url, user_id, payment_method, invoice_no, tax_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
		)
			.bind(
				data.store_name,
				data.total_amount,
				data.currency,
				data.receipt_date,
				data.category,
				data.descriptions,
				data.image_ref_url,
				userId,
				data.payment_method,
				data.invoice_no,
				data.tax_amount == 0 ? 0 : data.tax_amount,
			)
			.run();
		return c.json({ message: 'Succesfully added receipt' }, 201);
	} catch (e) {
		throw new HTTPException(500, { message: `Failed to add: ${e}` });
	}
});

// Add this helper function at the top of your file to convert files to Uint8Array
async function fileToUint8Array(file: File): Promise<Uint8Array> {
	const buffer = await file.arrayBuffer();
	return new Uint8Array(buffer);
}

receipts.post(
	'/upload',
	bodyLimit({
		maxSize: 5 * 1024 * 1024,
		onError: (c) => c.error('File too large', 413),
	}),
	async (c) => {
		try {
			const body = await c.req.parseBody();
			const userId = await authTools.getUserId(c);
			const file = body['file'] as File;

			const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
			if (!file || !allowedTypes.includes(file.type)) {
				return c.json({ error: 'Unsupported or missing file type.' }, 400);
			}

			// 1. Upload file to R2
			const safeName = file.name.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
			const fileName = `receipts/${userId}-${Date.now()}-${safeName}`;

			const uploadR2 = await c.env.R2.put(fileName, file, {
				httpMetadata: { contentType: file.type },
			});
			if (!uploadR2) throw new Error('R2 storage write failed');
			const url = `${c.env.R2_PUBLIC_URL || 'https://pub-your-id.r2.dev'}/${fileName}`;

			const prompt = `Analyze this receipt image and extract these specific fields. 
				Write your answer in a simple line-by-line list format. Do not use markdown backticks.

				Use these exact labels followed by a colon:
				STORE_NAME: (Name of store in UPPERCASE)
				CATEGORY: (Choose one: FOOD & BEVERAGES, GROCERIES, TRANSPORT, UTILITIES, ENTERTAINMENT, SHOPPING, HEALTHCARE, OTHERS)
				CURRENCY: (3-letter code like MYR, USD, SGD)
				TOTAL_AMOUNT: (Number only)
				TAX_AMOUNT: (Number only)
				INVOICE_NO: (Receipt identifier string)
				RECEIPT_DATE: (Strictly YYYY-MM-DD format)
				DESCRIPTIONS: (Physical address of the store)`;

			const imageUint8 = await fileToUint8Array(file);
			let extractedData = null;

			// Replace your parsing section in backend/src/routes/receipts.ts with this:

			try {
				const aiResponse: any = await c.env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
					prompt: prompt,
					image: [...imageUint8],
					max_tokens: 512,
				});

				let rawText = '';
				if (typeof aiResponse === 'string') {
					rawText = aiResponse;
				} else if (aiResponse && typeof aiResponse.response === 'string') {
					rawText = aiResponse.response;
				} else if (aiResponse && typeof aiResponse.text === 'string') {
					rawText = aiResponse.text;
				}

				console.log('=== WORKERS AI LINE OUTPUT ===\n', rawText);

				// Initialize our clean tracking dataset
				const parsedData = {
					store_name: '',
					category: 'OTHERS',
					currency: 'MYR',
					total_amount: 0.0,
					tax_amount: 0.0,
					invoice_no: '',
					receipt_date: '',
					descriptions: '',
				};

				// Helper helper to locate and isolate values beside our custom labels
				const getLineValue = (label: string, text: string): string => {
					// Looks for "LABEL:" or "**LABEL:**" anywhere in the line
					const regex = new RegExp(`(?:\\*\\*\\s*)?${label}\\s*:(?:\\s*\\*\\*)?\\s*([^\\n\\r]+)`, 'i');
					const match = text.match(regex);
					return match && match[1] ? match[1].replace(/["'*]/g, '').trim() : '';
				};

				// Parse text fields directly
				parsedData.store_name = getLineValue('STORE_NAME', rawText).toUpperCase();
				parsedData.invoice_no = getLineValue('INVOICE_NO', rawText);
				parsedData.descriptions = getLineValue('DESCRIPTIONS', rawText);

				// Validate category selection cleanly
				const extractedCategory = getLineValue('CATEGORY', rawText).toUpperCase();
				const validCategories = [
					'FOOD & BEVERAGES',
					'GROCERIES',
					'TRANSPORT',
					'UTILITIES',
					'ENTERTAINMENT',
					'SHOPPING',
					'HEALTHCARE',
					'OTHERS',
				];
				if (validCategories.includes(extractedCategory)) {
					parsedData.category = extractedCategory;
				}

				// Capture Currency strings
				const extractedCurrency = getLineValue('CURRENCY', rawText).toUpperCase();
				if (extractedCurrency) parsedData.currency = extractedCurrency;

				// Standardize numbers
				const extractedTotal = getLineValue('TOTAL_AMOUNT', rawText);
				if (extractedTotal) parsedData.total_amount = parseFloat(extractedTotal) || 0.0;

				const extractedTax = getLineValue('TAX_AMOUNT', rawText);
				if (extractedTax) parsedData.tax_amount = parseFloat(extractedTax) || 0.0;

				// Capture exact date representations
				const extractedDate = getLineValue('RECEIPT_DATE', rawText);
				if (extractedDate) parsedData.receipt_date = extractedDate;

				// Map finalized extraction block
				extractedData = parsedData;
				console.log('Final Normalized Output Object:', extractedData);
			} catch (aiError) {
				console.error('Data Extraction Pipeline completely failed:', aiError);
			}
			return c.json({
				success: true,
				url: url,
				ocr: extractedData,
			});
		} catch (err: any) {
			console.error(err);
			throw new HTTPException(500, { message: 'Internal server storage error.' });
		}
	},
);

// update receipts
receipts.put('/edit', zValidator('json', EditReceiptDto), async (c) => {
	const data = c.req.valid('json');
	const userId = await authTools.getUserId(c);
	try {
		const result = await c.env.DB.prepare(
			`
    UPDATE receipts 
    SET 
        store_name = ?, 
        total_amount = ?, 
        currency = ?, 
        receipt_date = ?, 
        category = ?, 
        descriptions = ?, 
        image_ref_url = ?, 
        payment_method = ?, 
        invoice_no = ?, 
        tax_amount = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
`,
		)
			.bind(
				data.store_name,
				data.total_amount,
				data.currency,
				data.receipt_date,
				data.category,
				data.descriptions,
				data.image_ref_url,
				data.payment_method,
				data.invoice_no,
				data.tax_amount,
				data.id,
				userId,
			)
			.run();
		if (!result.success) {
			throw new Error('Update failed at database level');
		}
		return c.json({ message: 'Succesfully edited receipt' }, 200);
	} catch (e) {
		throw new HTTPException(500, { message: `Failed to edit: ${e}` });
	}
});

// delete receipts
receipts.delete('/delete/:id', zValidator('param', IdParamSchema), async (c) => {
	const userId = await authTools.getUserId(c);
	const { id } = c.req.valid('param');
	try {
		const query = await c.env.DB.prepare('DELETE FROM receipts WHERE id = ? AND user_id = ?').bind(id, userId).run();
		if (!query.success) throw new Error('Failed to delete receipt');
		return c.json({ message: 'Successfully deleted receipt' }, 200);
	} catch (e) {
		throw new HTTPException(500, { message: `Failed to delete receipt: ${e}` });
	}
});

// analytics
// analytics summary
receipts.get('/analytics/receipts-summary', zValidator('query', AnalyticsQuerySchema), async (c) => {
	const userId = await authTools.getUserId(c);
	const filters = c.req.valid('query');

	try {
		// Base query setup
		let queryStr = `
            SELECT 
                COUNT(id) as total_receipts,
                COALESCE(SUM(total_amount), 0) as total_spent,
                COALESCE(SUM(tax_amount), 0) as total_tax
            FROM receipts 
            WHERE user_id = ?
        `;
		const queryParams: any[] = [userId];

		// 1. Handle Date Ranges cleanly using SQLite date modifiers
		if (filters.rangeType === 'custom' && filters.startDate && filters.endDate) {
			queryStr += ` AND receipt_date BETWEEN ? AND ?`;
			queryParams.push(filters.startDate, filters.endDate);
		} else if (filters.rangeType === 'month') {
			// Default to current year/month if not provided
			const targetYear = filters.year || new Date().getFullYear().toString();
			const targetMonth = filters.month || String(new Date().getMonth() + 1).padStart(2, '0');

			// Matches YYYY-MM prefixing in the database
			queryStr += ` AND strftime('%Y-%m', receipt_date) = ?`;
			queryParams.push(`${targetYear}-${targetMonth}`);
		}

		// 2. Handle specific dynamic categorization types
		if (filters.category) {
			queryStr += ` AND category = ?`;
			queryParams.push(filters.category);
		}

		// Execute core summary calculations
		const summary: any = await c.env.DB.prepare(queryStr)
			.bind(...queryParams)
			.first();

		// Optional: Get category breakdown alongside totals to populate graphs
		let breakdownQuery = `
            SELECT category, COUNT(id) as count, COALESCE(SUM(total_amount), 0) as amount 
            FROM receipts 
            WHERE user_id = ?
        `;
		const breakdownParams: any[] = [userId];

		// Copy the same date logic over to the breakdown list query
		if (filters.rangeType === 'custom' && filters.startDate && filters.endDate) {
			breakdownQuery += ` AND receipt_date BETWEEN ? AND ?`;
			breakdownParams.push(filters.startDate, filters.endDate);
		} else if (filters.rangeType === 'month') {
			const targetYear = filters.year || new Date().getFullYear().toString();
			const targetMonth = filters.month || String(new Date().getMonth() + 1).padStart(2, '0');
			breakdownQuery += ` AND strftime('%Y-%m', receipt_date) = ?`;
			breakdownParams.push(`${targetYear}-${targetMonth}`);
		}

		breakdownQuery += ` GROUP BY category ORDER BY amount DESC`;
		const { results: categories } = await c.env.DB.prepare(breakdownQuery)
			.bind(...breakdownParams)
			.all();

		return c.json({
			success: true,
			summary: {
				total_receipts: Number(summary.total_receipts),
				total_spent: Number(summary.total_spent),
				total_tax: Number(summary.total_tax),
			},
			categoryBreakdown: categories,
		});
	} catch (e) {
		throw new HTTPException(500, { message: `Analytics error: ${e}` });
	}
});
export default receipts;
