# Express adapter

`@aikdna/kdna-web-server/express` provides a pre-built Express router
you can mount at any path.

---

## Minimal setup

```js
import express from 'express'
import { createKDNARouter } from '@aikdna/kdna-web-server/express'

const app = express()

app.use('/api/kdna', createKDNARouter({
  storageDir: process.env.KDNA_STORAGE_DIR ?? '/tmp/kdna',
  activationServerUrl: process.env.KDNA_ACTIVATION_URL,
}))

app.listen(3000, () => console.log('Listening on :3000'))
```

---

## With authentication middleware

Mount your auth middleware before the KDNA router:

```js
import { requireAuth } from './middleware/auth.js'

app.use('/api/kdna', requireAuth, createKDNARouter({ storageDir: '/tmp/kdna' }))
```

The KDNA router does not handle authentication. Apply it at the
application layer.

---

## Mounting individual handlers

```js
import express from 'express'
import { validateHandler, loadHandler } from '@aikdna/kdna-web-server/express'

const app = express()

const opts = { storageDir: '/tmp/kdna' }
app.post('/api/kdna/validate', validateHandler(opts))
app.post('/api/kdna/load',     loadHandler(opts))
```

---

## CommonJS

```js
const { createKDNARouter } = require('@aikdna/kdna-web-server/express')
```

---

## Deployment notes

- Set `storageDir` to a path that is **not** served as a static
  directory by Express or any reverse proxy.
- In a multi-process setup, `storageDir` must be on a shared
  filesystem if you want file IDs to resolve across processes.
  Alternatively, use a sticky session or a shared object storage
  adapter (see [configuration options](../../README.md#configuration)).
