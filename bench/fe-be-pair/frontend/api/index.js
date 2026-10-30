// One call per line so the extractor (request.<verb>('<path>')) sees them all.
// Ground truth for what this produces lives in tests/fe-be-pair.test.mjs.
const request = {
  get: (url) => ({ url, verb: 'GET' }),
  post: (url, body) => ({ url, verb: 'POST', body }),
  put: (url, body) => ({ url, verb: 'PUT', body }),
  delete: (url) => ({ url, verb: 'DELETE' }),
};

// 6 paths that pair with a backend route (2 of them via {id} params)
export const matched = {
  orders: () => request.get('/api/orders'),
  createOrder: (body) => request.post('/api/orders', body),
  order: () => request.get('/api/orders/1'),
  removeOrder: () => request.delete('/api/orders/1'),
  products: () => request.get('/api/products'),
  buy: (body) => request.post('/api/products/7/buy', body),
  users: () => request.get('/api/users'),
  updateUser: (body) => request.put('/api/users/3', body),
};

// 1 path exists on the backend but under a different verb
export const wrongVerb = () => request.post('/api/wrong-method', {});

// 2 paths that pair with service-delegating handlers (shape M1)
export const coupons = () => request.get('/api/coupons');
export const deepShape = () => request.get('/api/deep');

// 2 paths the backend never declared
export const ghost = () => request.get('/api/ghost-a');
export const ghost2 = () => request.get('/api/ghost-b');

// 1 dynamically built path: counted by fe-dynamic-request-path, excluded from matchRate
export const ordersByStatus = (status) => request.get('/api/orders?status=' + status);
