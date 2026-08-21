/**
 * The app is published as a GitHub Pages *project* site, so it is served from
 * https://naturalclar.github.io/bass-tabs/ rather than a domain root and every
 * asset URL carries this prefix.
 *
 * Two places need it and they sit in different tsconfig projects: Vite takes it
 * as `base`, and the print checks navigate to it to reach the app the way the
 * deployed site serves it. Keeping the one copy here is what stops those two
 * from drifting apart.
 */
export const BASE_PATH = '/bass-tabs/'
