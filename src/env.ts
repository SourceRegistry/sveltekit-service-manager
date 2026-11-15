import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_SERVICE_ENTRYPOINT: {
		public: true,
		description: 'Base path of the service gateway route used by the client `Service()` helper.',
		schema: (value) => value
	}
});
