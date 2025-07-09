import { defineConfig } from 'vite';

// Are we running inside a GH Action?
const inGH = process.env.GITHUB_ACTIONS === 'true';
// The repo name is always the bit after the “/” 
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';

export default defineConfig({
    // Locally you still get “/”, but on Actions you get “/slammer/”
    base: inGH ? `/${repo}/` : '/',
    // …your other Vite options
});
