export interface AppConfiguration {
  port: number;
  nodeEnv: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  ldap: {
    host: string;
    baseDn: string;
    userDnTemplate: string;
    tlsSkipVerify: boolean;
    startTls: boolean;
    bindDn: string;
    bindPassword: string;
    requiredGroup: string;
    adminGroup: string;
  };
  downloadLink: {
    secret: string;
  };
  pdfExtractor: {
    url: string;
  };
}

export default (): AppConfiguration => ({
  port: parseInt(process.env['PORT'] ?? '8080', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  database: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  redis: {
    url: process.env['REDIS_URL'] ?? '',
  },
  jwt: {
    secret: process.env['JWT_SECRET'] ?? 'change-me-in-production',
    expiresIn: process.env['JWT_EXPIRES_IN'] ?? '8h',
  },
  ldap: {
    host: process.env['LDAP_HOST'] ?? '',
    baseDn: process.env['LDAP_BASE_DN'] ?? '',
    userDnTemplate: process.env['LDAP_USER_DN_TEMPLATE'] ?? '%s',
    tlsSkipVerify: process.env['LDAP_TLS_SKIP_VERIFY'] === 'true',
    startTls: process.env['LDAP_STARTTLS'] === 'true',
    bindDn: process.env['LDAP_BIND_DN'] ?? '',
    bindPassword: process.env['LDAP_BIND_PASSWORD'] ?? '',
    requiredGroup: process.env['LDAP_REQUIRED_GROUP'] ?? 'COMUNICAPA_USERS',
    adminGroup: process.env['LDAP_ADMIN_GROUP'] ?? 'COMUNICAPA_ADMINS',
  },
  downloadLink: {
    secret: process.env['DOWNLOAD_LINK_SECRET'] ?? 'change-me-in-production',
  },
  pdfExtractor: {
    url: process.env['PDF_EXTRACTOR_URL'] ?? 'http://pdf-extractor:8000',
  },
});
