import { z } from 'zod';

export const CreateReceiptDto = z.object({
	store_name: z.string().min(1, 'Store name is required').uppercase(),
	total_amount: z.number().positive(),
	currency: z.enum(['MYR', 'JPY', 'SGD', 'USD']).default('MYR'),
	receipt_date: z.string().datetime(),
	category: z.string().uppercase().optional(),
	descriptions: z.string().max(500).optional(),
	image_ref_url: z.url('Invalid image url'),
	invoice_no: z.string().optional(),
	tax_amount: z.number().min(0).optional(),
	payment_method: z.string().uppercase().optional(),
});

export type CreateReceiptType = z.infer<typeof CreateReceiptDto>;

export const ViewReceiptDto = z.object({
	id: z.number(),
	store_name: z.string().min(1, 'Store name is required').uppercase(),
	total_amount: z.number().positive(),
	tax_amount: z.number().positive(),
	currency: z.enum(['MYR', 'JPY', 'SGD', 'USD']).default('MYR'),
	receipt_date: z.string().datetime(),
	category: z.string().uppercase().optional(),
	payment_method: z.string().uppercase().optional(),
	descriptions: z.string().max(500).optional(),
	image_ref_url: z.url('Invalid image url'),
	invoice_no: z.string().optional(),
});

export type ViewReceiptType = z.infer<typeof ViewReceiptDto>;

export const EditReceiptDto = z.object({
	id: z.number(),
	store_name: z.string().min(1, 'Store name is required').uppercase(),
	total_amount: z.number().positive(),
	tax_amount: z.number().min(0).optional(),
	currency: z.enum(['MYR', 'JPY', 'SGD', 'USD']).default('MYR'),
	receipt_date: z.string().datetime(),
	category: z.string().uppercase().optional(),
	payment_method: z.string().uppercase().optional(),
	descriptions: z.string().max(500).optional(),
	image_ref_url: z.url('Invalid image url'),
	invoice_no: z.string().optional(),
});

export type EditReceiptType = z.infer<typeof EditReceiptDto>;
