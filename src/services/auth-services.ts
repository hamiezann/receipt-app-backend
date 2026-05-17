// auth function

export class AuthServices {
	async hashPassword(params: string): Promise<string> {
		const msgUint8 = new TextEncoder().encode(params);
		const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
		return btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
	}

	async verifyPassword(pass: string, hash: string): Promise<boolean> {
		return (await this.hashPassword(pass)) === hash;
	}

	async getUserId(c: any) {
		const payload = c.get('jwtPayload');
		if (!payload || !payload.sub) {
			throw new Error('Unauthorized man. Relogin back pls!');
		}

		return payload.sub;
	}
}
