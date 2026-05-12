import bcrypt from 'bcrypt';

const COST = 12;

export function hash(plaintext) {
  return bcrypt.hash(plaintext, COST);
}

export function verify(plaintext, hashValue) {
  return bcrypt.compare(plaintext, hashValue);
}

export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}
