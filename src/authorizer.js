export const handler = async (event) => {
  const header = event.headers?.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return { isAuthorized: token === process.env.API_TOKEN };
};
