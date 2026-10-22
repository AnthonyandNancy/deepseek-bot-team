// Entry point: `npm start` in hub/, or `node hub/src/index.js`.
//
// A configuration problem is reported as a plain sentence and a non-zero exit, not a stack:
// the operator's next action is to fix an environment variable, and the message says which.
import { ConfigError } from './config.js'
import { createHub } from './server.js'

try {
  const hub = createHub()
  const { url } = await hub.listen()
  const shutdown = async (signal) => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'info', event: 'hub.shutdown', signal })}\n`)
    await hub.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // The URL is printed so the operator can put it in the plugin's Hub account page.
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'info', event: 'hub.ready', url })}\n`)
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`hub: ${error.message}\n`)
    process.exit(2)
  }
  throw error
}
