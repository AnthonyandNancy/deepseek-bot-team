// A memoised `prepare`. `DatabaseSync.prepare` compiles SQL every call, and the hot paths here
// (membership check on every socket frame, event pull on every reconnect) would compile the same
// string thousands of times per session. Keyed by the exact SQL text, which is how the rest of the
// Hub already writes its statements.
export function prepared(db) {
  const cache = new Map()
  return function stmt(sql) {
    let statement = cache.get(sql)
    if (statement === undefined) {
      statement = db.prepare(sql)
      cache.set(sql, statement)
    }
    return statement
  }
}
