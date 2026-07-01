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
  oidc: {
    issuer: string;
    audience: string;
    jwksUri: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  };
  pec: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  };
  appIo: {
    apiKey: string;
    baseUrl: string;
  };
  send: {
    apiKey: string;
    baseUrl: string;
  };
  origins: {
    admin: string;
    citizen: string;
    publicApi: string;
  };
  brand: {
    name: string;
    logo: string;
  };
  retention: {
    maxDays: number;
  };
  downloadLink: {
    secret: string;
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
  oidc: {
    issuer: process.env['OIDC_ISSUER'] ?? '',
    audience: process.env['OIDC_AUDIENCE'] ?? 'comunicapa',
    jwksUri: process.env['OIDC_JWKS_URI'] ?? '',
  },
  smtp: {
    host: process.env['SMTP_HOST'] ?? 'localhost',
    port: parseInt(process.env['SMTP_PORT'] ?? '587', 10),
    secure: process.env['SMTP_SECURE'] === 'true',
    user: process.env['SMTP_USER'] ?? '',
    password: process.env['SMTP_PASSWORD'] ?? '',
    from: process.env['SMTP_FROM'] ?? 'noreply@comunicapa.local',
  },
  pec: {
    host: process.env['PEC_HOST'] ?? 'localhost',
    port: parseInt(process.env['PEC_PORT'] ?? '587', 10),
    secure: process.env['PEC_SECURE'] === 'true',
    user: process.env['PEC_USER'] ?? '',
    password: process.env['PEC_PASSWORD'] ?? '',
    from: process.env['PEC_FROM'] ?? 'noreply@pec.comunicapa.local',
  },
  appIo: {
    apiKey: process.env['APP_IO_API_KEY'] ?? '',
    baseUrl: process.env['APP_IO_BASE_URL'] ?? 'https://api.io.italia.it',
  },
  send: {
    apiKey: process.env['SEND_API_KEY'] ?? '',
    baseUrl: process.env['SEND_BASE_URL'] ?? 'https://api.notifichedigitali.it',
  },
  origins: {
    admin: process.env['ADMIN_ORIGIN'] ?? 'http://localhost:3000',
    citizen: process.env['CITIZEN_ORIGIN'] ?? 'http://localhost:3001',
    publicApi: process.env['PUBLIC_BACKEND_URL'] ?? 'http://localhost:8080',
  },
  brand: {
    name: process.env['BRAND_NAME'] ?? 'Comune di Montesilvano',
    logo: process.env['BRAND_LOGO'] ?? 'brand-logo.png',
  },
  retention: {
    maxDays: parseInt(process.env['RETENTION_MAX_DAYS'] ?? '90', 10),
  },
  downloadLink: {
    secret: process.env['DOWNLOAD_LINK_SECRET'] ?? 'change-me-in-production',
  },
});
