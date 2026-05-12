import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = '7d';

if (!SECRET) {
  throw new Error('JWT_SECRET is not set');
}

export function sign({ sub, provider }) {
  return jwt.sign({ sub, provider }, SECRET, { algorithm: 'HS256', expiresIn: EXPIRES_IN });
}

export function verify(token) {
  return jwt.verify(token, SECRET, { algorithms: ['HS256'] });
}
