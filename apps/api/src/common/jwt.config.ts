export const jwtModuleOptionsFactory = () => {
  if (process.env.JWT_PRIVATE_KEY) {
    return {
      privateKey: process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'),
      signOptions: {
        algorithm: 'RS256' as const,
        expiresIn: parseInt(process.env.JWT_ACCESS_TTL || '900', 10),
        issuer: 'BusinessHub',
      },
    };
  }
  return {
    secret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
    signOptions: {
      expiresIn: parseInt(process.env.JWT_ACCESS_TTL || '900', 10),
      issuer: 'BusinessHub',
    },
  };
};
