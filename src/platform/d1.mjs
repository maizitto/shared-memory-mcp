/** Read from the primary D1 session when the binding supports sessions. */
export function primary(db) { return db.withSession ? db.withSession('first-primary') : db; }
