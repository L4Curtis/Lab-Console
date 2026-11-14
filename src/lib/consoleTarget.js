/**
 * A console line's identity: the console server and its port. Two devices
 * on the same line (a line shared by two benches) have the same key; rooms,
 * the line watch and the bench rules all speak in these keys
 */

/** `${host}:${port}` of a console target, or null when there is none */
export const targetKey = (t) => (t ? `${t.host}:${t.port}` : null);
