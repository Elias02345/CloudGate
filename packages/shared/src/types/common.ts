import { z } from 'zod';

export const PaginationSchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	per_page: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export interface PaginatedResponse<T> {
	data: T[];
	page: number;
	per_page: number;
	total: number;
}

export interface ApiError {
	error: string;
	code: string;
	details?: Record<string, unknown>;
}
