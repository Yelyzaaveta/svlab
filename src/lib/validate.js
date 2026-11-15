const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateUser(input) {
  const errors = [];
  if (!input.userId) errors.push('userId is required');
  if (!input.name || input.name.length > 100)
    errors.push('name is required, max 100 chars');
  if (!EMAIL.test(input.email ?? ""))
    errors.push('email is not valid');
  return errors;
}
