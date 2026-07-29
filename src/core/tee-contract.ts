/** Maximum UTF-8 body retained across the MAIN-world tee boundary. */
export const MAX_TEE_BODY_BYTES = 8 * 1024 * 1024

/** Maximum concurrent page responses cloned by the MAIN-world tee. */
export const MAX_TEE_CAPTURES_IN_FLIGHT = 4

/** Longest page route identity carried with one observed response. */
export const MAX_TEE_ROUTE_BYTES = 8 * 1024
