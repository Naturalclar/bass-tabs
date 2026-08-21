import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { BASE_PATH } from './base-path.ts'

// https://vite.dev/config/
export default defineConfig({
  // Set for dev as well as build, so `npm run dev` resolves paths the same way
  // the deployed site does. A base that only exists in the production build is
  // a difference you discover in production.
  base: BASE_PATH,
  plugins: [react()],
})
