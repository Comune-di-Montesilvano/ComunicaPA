import React from 'react';
import {
  Mail, MailOpen, Smartphone, Send, MailCheck, Globe, HelpCircle, Stamp, ShieldCheck
} from 'lucide-react';

export interface ChannelMetaConfig {
  key: string;
  label: string;
  shortLabel?: string;
  badge: string;
  color: string;
  bgLight: string;
  logoUrl?: string;
  icon: React.ComponentType<{ className?: string; size?: number }>;
}

/**
 * Loghi SVG ufficiali embedded nel repository (Data URIs).
 * - APP_IO: https://ioapp.it/assets/IO_84d780c485.svg
 * - SEND:   https://assistenza.notifichedigitali.it/hc/theming_assets/01K5TV4VM21SZ9TC5VJTGPQ8NJ
 * - INAD:   https://domiciliodigitale.gov.it/dgit/home/assets/img/logo.svg
 */
export const EMBEDDED_LOGOS = {
  APP_IO: `data:image/svg+xml;utf8,<svg width="57" height="55" viewBox="0 0 57 55" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.80308 7.16724C12.5938 7.16724 14.8562 9.44308 14.8562 12.2505C14.8562 15.0579 12.5938 17.3337 9.80308 17.3337C7.01234 17.3337 4.75 15.0579 4.75 12.2505C4.75 9.44308 7.01234 7.16724 9.80308 7.16724ZM52.25 31.5664C52.25 40.5501 45.0105 47.8328 36.8501 47.8328C27.1498 47.8328 19.9103 40.5501 19.9103 31.5664C19.9103 22.5828 27.1498 15.3001 36.8501 15.3001C45.0105 15.3001 52.25 22.5828 52.25 31.5664ZM13.8477 26.4827C13.8477 24.2367 12.0378 22.4161 9.80521 22.4161C7.57262 22.4161 5.76275 24.2367 5.76275 26.4827V43.7657C5.76275 46.0116 7.57262 47.8323 9.80521 47.8323C12.0378 47.8323 13.8477 46.0116 13.8477 43.7657V26.4827ZM40.0533 29.8593H42.206V27.7284H40.0688V25.1515H37.7303V33.7246C37.7303 35.0791 37.9161 36.0042 38.3033 36.4997C38.675 37.0118 39.3874 37.2596 40.4405 37.2596C40.8432 37.2596 41.4472 37.1605 42.2215 36.9788L42.1131 34.9965L40.7812 35.0296C40.5489 35.0296 40.3786 34.98 40.2702 34.8644C40.1617 34.7488 40.0998 34.6166 40.0843 34.4679C40.0688 34.3028 40.0533 34.055 40.0533 33.6751V29.8593ZM33.0028 27.7441V37.0441H35.3414V27.7441H33.0028ZM29.497 27.5138C29.9057 27.5138 30.2516 27.6522 30.5188 27.9292C30.7861 28.2062 30.9118 28.5447 30.9118 28.9601C30.9118 29.3756 30.7861 29.6987 30.5188 29.9757C30.2673 30.2219 29.9371 30.3604 29.5127 30.3604C29.1039 30.3604 28.7581 30.2219 28.4908 29.9449C28.2236 29.6679 28.0821 29.3294 28.0821 28.9294C28.0821 28.5293 28.2236 28.1908 28.4751 27.9138C28.7424 27.6368 29.0882 27.5138 29.497 27.5138Z" fill="%230B3EE3"/></svg>`,
  SEND: `data:image/svg+xml;utf8,<svg width="75" height="25" viewBox="0 0 75 25" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.50075 9.08271C9.44153 9.1593 10.4607 9.24226 11.4508 9.54981C13.94 10.3239 15.4339 12.2719 15.4339 15.025C15.4339 18.8653 12.5848 21.6748 8.24258 21.6748C4.0663 21.6748 0.968262 19.038 0.968262 15.1392H4.26298C4.26298 17.0886 5.97799 18.3781 8.30116 18.3781C10.7073 18.3781 12.1455 17.0323 12.1455 15.2253C12.1455 13.964 11.3992 13.1906 10.4305 12.8176C9.70934 12.5389 8.79293 12.4553 7.8291 12.3673C6.90802 12.2833 5.94364 12.1952 5.06503 11.9293C2.52077 11.1552 1.13774 9.11974 1.13774 6.54006C1.13774 2.84292 3.98679 0.120117 8.10797 0.120117C12.1455 0.120117 15.1326 2.67089 15.1326 6.36875H11.8142C11.7305 4.59138 10.2373 3.4161 8.08008 3.4161C5.86361 3.4161 4.45338 4.7063 4.45338 6.36875C4.45338 7.45802 5.06155 8.28924 6.11259 8.6904C6.7422 8.94219 7.60196 9.00954 8.50075 9.08271ZM57.6312 0.435267H64.1307C69.9941 0.435267 74.2261 4.99254 74.2261 10.926C74.2261 16.8595 69.9941 21.3597 64.1307 21.3597H62.6507V24.7128L57.8042 19.6828L62.6507 14.6571V18.0059H64.0756C68.058 18.0059 70.907 14.939 70.907 10.926C70.907 6.85593 68.058 3.78908 64.0756 3.78908H60.9496V11.0605L57.6312 14.5415V0.435267ZM18.8897 21.3597H34.2955V18.0059H22.1816V12.5307H29.0124V9.17757H22.1816V3.78835H34.2955V0.435267H18.8897V21.3597ZM41.2923 0.435267L50.668 15.3402V0.435267H53.9592V21.3597H50.668L41.2923 6.45477V21.3597H38.0003V0.435267H41.2923Z" fill="%23003366"/></svg>`,
  INAD: `data:image/svg+xml;utf8,<svg width="45" height="44" viewBox="0 0 45 44" xmlns="http://www.w3.org/2000/svg"><g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd"><g transform="translate(-123, -2173)"><g transform="translate(124.5, 2173.5)"><rect fill="%2317324D" x="14.66" y="30.96" width="2.22" height="12"/><rect fill="%2317324D" x="19.2" y="30.96" width="4.44" height="12"/><path d="M7.83,9.88 L32.95,9.88 C37.85,9.88 41.83,13.86 41.83,18.77 L41.83,32.1 L7.83,32.1 Z" stroke="%23FFFFFF" stroke-width="2.2" fill="%2317324D"/><path d="M9,9.88 C13.97,9.88 18,13.91 18,18.88 L18,32.1 L0,32.1 L0,18.88 C0,13.91 4.02,9.88 9,9.88 Z" stroke="%23FFFFFF" stroke-width="2.2" fill="%2317324D"/><path d="M5,19.52 L13,19.52" stroke="%23FFFFFF" stroke-width="2.2"/><rect fill="%2317324D" x="24.2" y="5.44" width="3" height="16.29"/><rect fill="%23FFFFFF" x="27.2" y="4.76" width="2.2" height="18"/><path d="M24.2,0.23 L29.2,0.23 C30.85,0.23 32.2,1.58 32.2,3.23 C32.2,4.89 30.85,6.23 29.2,6.23 L24.2,6.23 Z" fill="%2317324D"/></g></g></g></svg>`,
};

export const CHANNELS_REGISTRY: Record<string, ChannelMetaConfig> = {
  EMAIL: {
    key: 'EMAIL',
    label: 'E-Mail',
    shortLabel: 'E-Mail',
    badge: 'bg-success text-white',
    color: '#008758',
    bgLight: '#E6F5EE',
    icon: Mail,
  },
  PEC: {
    key: 'PEC',
    label: 'PEC',
    shortLabel: 'PEC',
    badge: 'bg-info text-dark',
    color: '#0073E6',
    bgLight: '#E5F1FC',
    icon: MailOpen,
  },
  APP_IO: {
    key: 'APP_IO',
    label: 'App IO',
    shortLabel: 'App IO',
    badge: 'bg-primary text-white',
    color: '#0066CC',
    bgLight: '#F0F7FF',
    logoUrl: EMBEDDED_LOGOS.APP_IO,
    icon: Smartphone,
  },
  SEND: {
    key: 'SEND',
    label: 'SEND',
    shortLabel: 'SEND',
    badge: 'bg-warning text-dark',
    color: '#003366',
    bgLight: '#FFF8E6',
    logoUrl: EMBEDDED_LOGOS.SEND,
    icon: Send,
  },
  POSTAL: {
    key: 'POSTAL',
    label: 'Postalizzazione',
    shortLabel: 'Postalizzazione',
    badge: 'bg-secondary text-white',
    color: '#475569',
    bgLight: '#F1F5F9',
    icon: MailCheck,
  },
  PROTOCOLLAZIONE: {
    key: 'PROTOCOLLAZIONE',
    label: 'Protocollazione',
    shortLabel: 'Protocollazione',
    badge: 'bg-dark text-white',
    color: '#334155',
    bgLight: '#F8FAFC',
    icon: Stamp,
  },
  INAD: {
    key: 'INAD',
    label: 'INAD',
    shortLabel: 'INAD',
    badge: 'bg-primary text-white',
    color: '#0066CC',
    bgLight: '#EBF5FF',
    logoUrl: EMBEDDED_LOGOS.INAD,
    icon: ShieldCheck,
  },
  CITIZEN_PORTAL: {
    key: 'CITIZEN_PORTAL',
    label: 'Portale Cittadino',
    shortLabel: 'Portale',
    badge: 'bg-primary text-white',
    color: '#0066CC',
    bgLight: '#EBF5FF',
    icon: Globe,
  },
  PORTALE_CITTADINO: {
    key: 'PORTALE_CITTADINO',
    label: 'Portale Cittadino',
    shortLabel: 'Portale',
    badge: 'bg-primary text-white',
    color: '#0066CC',
    bgLight: '#EBF5FF',
    icon: Globe,
  },
  UNKNOWN: {
    key: 'UNKNOWN',
    label: 'Sconosciuto',
    badge: 'bg-secondary text-white',
    color: '#64748B',
    bgLight: '#F1F5F9',
    icon: HelpCircle,
  },
};

export const ENGINE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(CHANNELS_REGISTRY).map(([key, meta]) => [key, meta.label])
);

export function getChannelMeta(channel?: string | null): ChannelMetaConfig {
  const normKey = (channel || '').toUpperCase();
  return CHANNELS_REGISTRY[normKey] ?? {
    key: channel || 'UNKNOWN',
    label: channel || 'Sconosciuto',
    badge: 'bg-secondary text-white',
    color: '#64748B',
    bgLight: '#F1F5F9',
    icon: HelpCircle,
  };
}

export function channelLabel(channel?: string | null): string {
  return getChannelMeta(channel).label;
}
