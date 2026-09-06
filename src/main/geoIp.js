'use strict';

const https = require('https');

/**
 * Maps ISO 3166-1 alpha-2 country codes to friendly names.
 */
const COUNTRY_NAMES = {
  US: 'United States',
  GB: 'United Kingdom',
  DE: 'Germany',
  FR: 'France',
  RU: 'Russia',
  CN: 'China',
  JP: 'Japan',
  IN: 'India',
  CA: 'Canada',
  AU: 'Australia',
  BR: 'Brazil',
  NL: 'Netherlands',
  IT: 'Italy',
  ES: 'Spain',
  SE: 'Sweden',
  PL: 'Poland',
  UA: 'Ukraine',
  KR: 'South Korea',
  TW: 'Taiwan',
  HK: 'Hong Kong',
  SG: 'Singapore',
  CH: 'Switzerland',
  NO: 'Norway',
  FI: 'Finland',
  DK: 'Denmark',
  AT: 'Austria',
  BE: 'Belgium',
  CZ: 'Czech Republic',
  RO: 'Romania',
  HU: 'Hungary',
  PT: 'Portugal',
  GR: 'Greece',
  TR: 'Turkey',
  MX: 'Mexico',
  AR: 'Argentina',
  CL: 'Chile',
  CO: 'Colombia',
  ZA: 'South Africa',
  EG: 'Egypt',
  NG: 'Nigeria',
  KE: 'Kenya',
  ID: 'Indonesia',
  MY: 'Malaysia',
  TH: 'Thailand',
  VN: 'Vietnam',
  PH: 'Philippines',
  NZ: 'New Zealand',
  IE: 'Ireland',
  IL: 'Israel',
  IR: 'Iran',
  KZ: 'Kazakhstan',
  BY: 'Belarus',
  BG: 'Bulgaria',
  RS: 'Serbia',
  SK: 'Slovakia',
  HR: 'Croatia',
  LT: 'Lithuania',
  LV: 'Latvia',
  EE: 'Estonia',
  SI: 'Slovenia',
  IS: 'Iceland',
  PK: 'Pakistan',
  BD: 'Bangladesh',
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia',
  LAN: 'Local Network'
};

/**
 * Converts ISO 3166-1 alpha-2 country code to Regional Indicator flag emoji.
 */
function countryCodeToFlag(countryCode) {
  if (!countryCode) return '🌐';
  const code = String(countryCode).trim().toUpperCase();
  if (code === 'LAN' || code === 'LOCAL' || code === 'LOOPBACK') return '🏠';
  if (code === 'XX' || code === 'UNKNOWN' || code.length !== 2) return '🌐';
  
  const offset = 0x1F1E6 - 65;
  try {
    const first = code.charCodeAt(0) + offset;
    const second = code.charCodeAt(1) + offset;
    return String.fromCodePoint(first, second);
  } catch (e) {
    return '🌐';
  }
}

/**
 * Cleans an IP address or host:port string into a pure IPv4 or IPv6 string.
 */
function cleanIp(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();

  // Strip IPv4-mapped IPv6 prefix (e.g. ::ffff:192.0.2.1)
  if (s.startsWith('::ffff:')) {
    s = s.substring(7);
  }

  // Bracketed IPv6 e.g. [2001:db8::1]:80
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end !== -1) return s.substring(1, end);
  }

  // IPv4 with port e.g. 1.2.3.4:6881
  const colonIdx = s.lastIndexOf(':');
  if (colonIdx !== -1 && s.indexOf(':') === colonIdx) {
    s = s.substring(0, colonIdx);
  }

  return s;
}

/**
 * Converts dotted IPv4 string to 32-bit unsigned integer.
 */
function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const a = parseInt(parts[0], 10);
  const b = parseInt(parts[1], 10);
  const c = parseInt(parts[2], 10);
  const d = parseInt(parts[3], 10);
  if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) return null;
  if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) return null;
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

/**
 * Checks if an IP is local, loopback, or private LAN.
 */
function isPrivateIp(ip) {
  const s = cleanIp(ip);
  if (!s || s === 'localhost' || s === '::1') return true;
  const intVal = ipToInt(s);
  if (intVal === null) return false;

  // 127.0.0.0/8 (Loopback)
  if ((intVal >>> 24) === 127) return true;
  // 10.0.0.0/8 (Private)
  if ((intVal >>> 24) === 10) return true;
  // 172.16.0.0/12 (Private)
  if ((intVal >>> 20) === ((172 << 4) | 1)) return true;
  // 192.168.0.0/16 (Private)
  if ((intVal >>> 16) === ((192 << 8) | 168)) return true;
  // 169.254.0.0/16 (Link-local)
  if ((intVal >>> 16) === ((169 << 8) | 254)) return true;
  // 0.0.0.0/8 or 255.255.255.255
  if ((intVal >>> 24) === 0 || intVal === 0xFFFFFFFF) return true;

  return false;
}

/**
 * Compiles a CIDR string into an integer range [start, end, countryCode].
 */
function cidr(baseIp, prefix, countryCode) {
  const base = ipToInt(baseIp);
  if (base === null) return null;
  const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
  const start = (base & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return [start, end, countryCode];
}

// Built-in granular CIDR ranges for the most active BitTorrent swarms and autonomous systems
const RAW_CIDRS = [
  // Cloudflare, Google, Microsoft, AWS, Cloud & Major Public DNS/CDN
  ['1.1.1.0', 24, 'AU'],
  ['1.0.0.0', 24, 'AU'],
  ['8.8.8.0', 24, 'US'],
  ['8.8.4.0', 24, 'US'],
  ['9.9.9.0', 24, 'US'],
  ['13.64.0.0', 11, 'US'],
  ['20.0.0.0', 11, 'US'],
  ['23.0.0.0', 12, 'US'],
  ['34.64.0.0', 11, 'US'],
  ['35.184.0.0', 13, 'US'],
  ['52.0.0.0', 11, 'US'],
  ['54.0.0.0', 11, 'US'],
  ['104.16.0.0', 12, 'US'],
  ['142.250.0.0', 15, 'US'],

  // Asia / Pacific (APNIC)
  ['14.139.0.0', 16, 'IN'],
  ['14.140.0.0', 14, 'IN'],
  ['27.56.0.0', 14, 'IN'],
  ['27.106.0.0', 15, 'IN'],
  ['49.12.0.0', 14, 'DE'],
  ['49.32.0.0', 12, 'IN'],
  ['49.204.0.0', 14, 'IN'],
  ['59.88.0.0', 13, 'IN'],
  ['59.144.0.0', 12, 'IN'],
  ['103.21.244.0', 22, 'US'],
  ['103.22.140.0', 22, 'IN'],
  ['103.24.0.0', 14, 'IN'],
  ['106.51.0.0', 16, 'IN'],
  ['114.119.128.0', 18, 'SG'],
  ['115.111.0.0', 16, 'IN'],
  ['117.192.0.0', 11, 'IN'],
  ['122.160.0.0', 12, 'IN'],
  ['125.16.0.0', 12, 'IN'],
  ['182.64.0.0', 11, 'IN'],

  // China
  ['14.116.0.0', 14, 'CN'],
  ['27.16.0.0', 12, 'CN'],
  ['36.128.0.0', 10, 'CN'],
  ['42.120.0.0', 13, 'CN'],
  ['58.16.0.0', 12, 'CN'],
  ['59.32.0.0', 11, 'CN'],
  ['101.64.0.0', 11, 'CN'],
  ['110.16.0.0', 12, 'CN'],
  ['111.160.0.0', 11, 'CN'],
  ['112.0.0.0', 10, 'CN'],
  ['113.64.0.0', 10, 'CN'],
  ['114.216.0.0', 13, 'CN'],
  ['115.192.0.0', 11, 'CN'],
  ['116.208.0.0', 12, 'CN'],
  ['117.128.0.0', 10, 'CN'],
  ['118.112.0.0', 12, 'CN'],
  ['119.120.0.0', 13, 'CN'],
  ['120.192.0.0', 10, 'CN'],
  ['121.8.0.0', 13, 'CN'],
  ['122.96.0.0', 11, 'CN'],
  ['123.112.0.0', 12, 'CN'],
  ['124.114.0.0', 15, 'CN'],
  ['125.64.0.0', 11, 'CN'],
  ['163.177.0.0', 16, 'CN'],
  ['175.160.0.0', 11, 'CN'],
  ['180.96.0.0', 11, 'CN'],
  ['182.112.0.0', 12, 'CN'],
  ['183.128.0.0', 10, 'CN'],
  ['218.10.0.0', 15, 'CN'],
  ['219.128.0.0', 11, 'CN'],
  ['220.160.0.0', 11, 'CN'],
  ['221.192.0.0', 11, 'CN'],
  ['222.128.0.0', 11, 'CN'],
  ['223.166.0.0', 15, 'CN'],

  // Japan
  ['43.224.0.0', 12, 'JP'],
  ['60.32.0.0', 11, 'JP'],
  ['61.112.0.0', 12, 'JP'],
  ['110.66.0.0', 15, 'JP'],
  ['114.144.0.0', 12, 'JP'],
  ['118.104.0.0', 13, 'JP'],
  ['121.104.0.0', 13, 'JP'],
  ['122.16.0.0', 12, 'JP'],
  ['124.32.0.0', 11, 'JP'],
  ['126.0.0.0', 9, 'JP'],
  ['133.0.0.0', 10, 'JP'],
  ['150.0.0.0', 10, 'JP'],
  ['153.128.0.0', 11, 'JP'],
  ['210.128.0.0', 11, 'JP'],
  ['219.96.0.0', 11, 'JP'],
  ['220.96.0.0', 11, 'JP'],

  // South Korea
  ['58.120.0.0', 13, 'KR'],
  ['112.160.0.0', 11, 'KR'],
  ['115.88.0.0', 14, 'KR'],
  ['121.128.0.0', 10, 'KR'],
  ['175.192.0.0', 11, 'KR'],
  ['211.168.0.0', 13, 'KR'],
  ['218.144.0.0', 12, 'KR'],

  // Europe (RIPE) - Germany
  ['46.4.0.0', 14, 'DE'],
  ['46.163.0.0', 16, 'DE'],
  ['77.176.0.0', 12, 'DE'],
  ['78.46.0.0', 15, 'DE'],
  ['79.192.0.0', 10, 'DE'],
  ['80.128.0.0', 11, 'DE'],
  ['84.112.0.0', 12, 'DE'],
  ['85.16.0.0', 12, 'DE'],
  ['87.122.0.0', 15, 'DE'],
  ['88.64.0.0', 11, 'DE'],
  ['89.16.0.0', 12, 'DE'],
  ['91.0.0.0', 10, 'DE'],
  ['92.192.0.0', 10, 'DE'],
  ['94.192.0.0', 10, 'DE'],
  ['95.88.0.0', 13, 'DE'],
  ['141.0.0.0', 11, 'DE'],
  ['149.200.0.0', 13, 'DE'],
  ['178.62.0.0', 15, 'DE'],
  ['185.220.100.0', 22, 'DE'],
  ['188.96.0.0', 11, 'DE'],
  ['217.80.0.0', 12, 'DE'],

  // Russia
  ['77.37.0.0', 16, 'RU'],
  ['77.222.0.0', 15, 'RU'],
  ['78.106.0.0', 15, 'RU'],
  ['79.111.0.0', 16, 'RU'],
  ['83.149.0.0', 16, 'RU'],
  ['85.26.0.0', 15, 'RU'],
  ['87.224.0.0', 12, 'RU'],
  ['91.144.0.0', 13, 'RU'],
  ['92.243.0.0', 16, 'RU'],
  ['94.25.0.0', 16, 'RU'],
  ['95.173.128.0', 18, 'RU'],
  ['109.188.0.0', 14, 'RU'],
  ['176.14.0.0', 15, 'RU'],
  ['178.16.0.0', 12, 'RU'],
  ['185.15.0.0', 16, 'RU'],
  ['188.162.0.0', 15, 'RU'],
  ['212.45.0.0', 16, 'RU'],

  // United Kingdom
  ['25.0.0.0', 8, 'GB'],
  ['51.0.0.0', 9, 'GB'],
  ['81.128.0.0', 11, 'GB'],
  ['82.0.0.0', 11, 'GB'],
  ['86.0.0.0', 11, 'GB'],
  ['90.192.0.0', 11, 'GB'],
  ['92.0.0.0', 11, 'GB'],
  ['94.0.0.0', 11, 'GB'],
  ['109.144.0.0', 12, 'GB'],
  ['151.224.0.0', 11, 'GB'],
  ['212.58.240.0', 20, 'GB'],

  // France
  ['37.160.0.0', 12, 'FR'],
  ['78.192.0.0', 10, 'FR'],
  ['80.8.0.0', 13, 'FR'],
  ['82.64.0.0', 11, 'FR'],
  ['83.192.0.0', 10, 'FR'],
  ['86.192.0.0', 10, 'FR'],
  ['88.160.0.0', 11, 'FR'],
  ['90.0.0.0', 10, 'FR'],
  ['92.128.0.0', 11, 'FR'],
  ['109.8.0.0', 13, 'FR'],
  ['176.128.0.0', 11, 'FR'],

  // Netherlands
  ['31.148.0.0', 14, 'NL'],
  ['77.160.0.0', 11, 'NL'],
  ['82.168.0.0', 13, 'NL'],
  ['84.24.0.0', 13, 'NL'],
  ['85.144.0.0', 12, 'NL'],
  ['86.80.0.0', 12, 'NL'],
  ['87.208.0.0', 12, 'NL'],
  ['145.0.0.0', 12, 'NL'],
  ['185.10.0.0', 15, 'NL'],

  // Poland
  ['31.0.0.0', 11, 'PL'],
  ['77.65.0.0', 16, 'PL'],
  ['79.162.0.0', 15, 'PL'],
  ['83.0.0.0', 11, 'PL'],
  ['89.64.0.0', 11, 'PL'],
  ['178.36.0.0', 14, 'PL'],
  ['194.204.0.0', 16, 'PL'],

  // Ukraine
  ['46.118.0.0', 15, 'UA'],
  ['77.88.16.0', 20, 'UA'],
  ['77.120.0.0', 13, 'UA'],
  ['91.200.0.0', 13, 'UA'],
  ['93.72.0.0', 14, 'UA'],
  ['178.92.0.0', 14, 'UA'],
  ['188.163.0.0', 16, 'UA'],

  // Italy
  ['79.0.0.0', 10, 'IT'],
  ['80.16.0.0', 12, 'IT'],
  ['82.48.0.0', 12, 'IT'],
  ['87.0.0.0', 11, 'IT'],
  ['93.32.0.0', 11, 'IT'],
  ['94.160.0.0', 11, 'IT'],
  ['151.12.0.0', 14, 'IT'],

  // Spain
  ['80.24.0.0', 13, 'ES'],
  ['81.32.0.0', 11, 'ES'],
  ['83.32.0.0', 11, 'ES'],
  ['85.48.0.0', 12, 'ES'],
  ['88.0.0.0', 11, 'ES'],
  ['95.120.0.0', 13, 'ES'],
  ['212.166.0.0', 15, 'ES'],

  // Switzerland
  ['176.10.0.0', 15, 'CH'],
  ['178.82.0.0', 15, 'CH'],
  ['185.107.44.0', 22, 'CH'],
  ['194.230.0.0', 16, 'CH'],

  // Sweden
  ['78.64.0.0', 11, 'SE'],
  ['81.224.0.0', 11, 'SE'],
  ['85.224.0.0', 11, 'SE'],
  ['90.224.0.0', 11, 'SE'],
  ['194.14.0.0', 15, 'SE'],

  // Brazil & Latin America (LACNIC)
  ['168.0.0.0', 11, 'BR'],
  ['177.0.0.0', 10, 'BR'],
  ['179.0.0.0', 10, 'BR'],
  ['186.192.0.0', 10, 'BR'],
  ['187.0.0.0', 10, 'BR'],
  ['189.0.0.0', 10, 'BR'],
  ['191.0.0.0', 10, 'BR'],
  ['200.128.0.0', 10, 'BR'],
  ['201.0.0.0', 10, 'BR'],

  // Canada
  ['24.244.0.0', 14, 'CA'],
  ['64.230.0.0', 15, 'CA'],
  ['70.24.0.0', 13, 'CA'],
  ['72.136.0.0', 13, 'CA'],
  ['74.56.0.0', 13, 'CA'],
  ['96.20.0.0', 14, 'CA'],
  ['142.166.0.0', 15, 'CA'],
  ['174.88.0.0', 13, 'CA'],
  ['184.144.0.0', 12, 'CA'],
  ['198.16.0.0', 14, 'CA'],
  ['206.162.0.0', 15, 'CA'],

  // United States (ARIN - AT&T, Comcast, Verizon, Charter, Level 3, Lumen, Cox)
  ['3.0.0.0', 9, 'US'],
  ['4.0.0.0', 8, 'US'],
  ['6.0.0.0', 7, 'US'],
  ['12.0.0.0', 8, 'US'],
  ['15.0.0.0', 8, 'US'],
  ['16.0.0.0', 8, 'US'],
  ['17.0.0.0', 8, 'US'],
  ['18.0.0.0', 8, 'US'],
  ['24.0.0.0', 9, 'US'],
  ['32.0.0.0', 8, 'US'],
  ['38.0.0.0', 8, 'US'],
  ['40.64.0.0', 10, 'US'],
  ['44.0.0.0', 8, 'US'],
  ['47.0.0.0', 8, 'US'],
  ['50.0.0.0', 8, 'US'],
  ['63.0.0.0', 8, 'US'],
  ['64.0.0.0', 8, 'US'],
  ['65.0.0.0', 8, 'US'],
  ['66.0.0.0', 8, 'US'],
  ['67.0.0.0', 8, 'US'],
  ['68.0.0.0', 8, 'US'],
  ['69.0.0.0', 8, 'US'],
  ['70.0.0.0', 8, 'US'],
  ['71.0.0.0', 8, 'US'],
  ['72.0.0.0', 8, 'US'],
  ['73.0.0.0', 8, 'US'],
  ['74.0.0.0', 8, 'US'],
  ['75.0.0.0', 8, 'US'],
  ['76.0.0.0', 8, 'US'],
  ['96.0.0.0', 8, 'US'],
  ['97.0.0.0', 8, 'US'],
  ['98.0.0.0', 8, 'US'],
  ['99.0.0.0', 8, 'US'],
  ['100.0.0.0', 8, 'US'],
  ['107.0.0.0', 8, 'US'],
  ['108.0.0.0', 8, 'US'],
  ['128.0.0.0', 8, 'US'],
  ['129.0.0.0', 8, 'US'],
  ['130.0.0.0', 8, 'US'],
  ['131.0.0.0', 8, 'US'],
  ['132.0.0.0', 8, 'US'],
  ['134.0.0.0', 8, 'US'],
  ['135.0.0.0', 8, 'US'],
  ['136.0.0.0', 8, 'US'],
  ['137.0.0.0', 8, 'US'],
  ['138.0.0.0', 8, 'US'],
  ['140.0.0.0', 8, 'US'],
  ['144.0.0.0', 8, 'US'],
  ['173.0.0.0', 8, 'US'],
  ['174.0.0.0', 8, 'US'],
  ['184.0.0.0', 8, 'US'],
  ['198.0.0.0', 8, 'US'],
  ['199.0.0.0', 8, 'US'],
  ['204.0.0.0', 8, 'US'],
  ['205.0.0.0', 8, 'US'],
  ['206.0.0.0', 8, 'US'],
  ['207.0.0.0', 8, 'US'],
  ['208.0.0.0', 8, 'US'],
  ['209.0.0.0', 8, 'US'],
  ['216.0.0.0', 8, 'US']
];

// Compile ranges and sort by startInt
const RANGE_DATABASE = [];
for (const [ip, pfx, cc] of RAW_CIDRS) {
  const item = cidr(ip, pfx, cc);
  if (item) RANGE_DATABASE.push(item);
}
RANGE_DATABASE.sort((a, b) => a[0] - b[0]);

// Fallback regional allocations for /8 blocks
const REGIONAL_8_FALLBACK = {
  1: 'AU', 2: 'FR', 3: 'US', 4: 'US', 5: 'DE', 6: 'US', 7: 'US', 8: 'US', 9: 'US',
  11: 'US', 12: 'US', 13: 'US', 14: 'IN', 15: 'US', 16: 'US', 17: 'US', 18: 'US', 19: 'US', 20: 'US',
  23: 'US', 24: 'US', 25: 'GB', 26: 'US', 27: 'CN', 28: 'US', 29: 'US', 30: 'US', 31: 'NL',
  32: 'US', 33: 'US', 34: 'US', 35: 'US', 36: 'CN', 37: 'FR', 38: 'US', 39: 'CN', 40: 'US',
  41: 'ZA', 42: 'CN', 43: 'JP', 44: 'US', 46: 'DE', 47: 'US', 49: 'IN', 50: 'US', 51: 'GB',
  52: 'US', 53: 'DE', 54: 'US', 55: 'US', 56: 'US', 58: 'CN', 59: 'IN', 60: 'JP', 61: 'TW',
  62: 'GB', 63: 'US', 64: 'US', 65: 'US', 66: 'US', 67: 'US', 68: 'US', 69: 'US', 70: 'US',
  71: 'US', 72: 'US', 73: 'US', 74: 'US', 75: 'US', 76: 'US', 77: 'DE', 78: 'FR', 79: 'IT',
  80: 'DE', 81: 'GB', 82: 'FR', 83: 'ES', 84: 'DE', 85: 'RU', 86: 'GB', 87: 'RU', 88: 'DE',
  89: 'RU', 90: 'FR', 91: 'DE', 92: 'RU', 93: 'IT', 94: 'RU', 95: 'RU', 96: 'US', 97: 'US',
  98: 'US', 99: 'US', 100: 'US', 101: 'CN', 103: 'IN', 104: 'US', 105: 'ZA', 106: 'CN', 107: 'US',
  108: 'US', 109: 'RU', 110: 'CN', 111: 'CN', 112: 'KR', 113: 'CN', 114: 'CN', 115: 'CN', 116: 'CN',
  117: 'CN', 118: 'JP', 119: 'CN', 120: 'CN', 121: 'CN', 122: 'CN', 123: 'CN', 124: 'CN', 125: 'CN',
  126: 'JP', 128: 'US', 129: 'US', 130: 'US', 131: 'US', 132: 'US', 133: 'JP', 134: 'US', 135: 'US',
  136: 'US', 137: 'US', 138: 'US', 139: 'US', 140: 'US', 141: 'DE', 142: 'CA', 143: 'US', 144: 'US',
  145: 'NL', 146: 'GB', 147: 'GB', 148: 'GB', 149: 'DE', 150: 'JP', 151: 'IT', 152: 'US', 153: 'JP',
  154: 'US', 155: 'US', 156: 'US', 157: 'JP', 158: 'JP', 159: 'US', 160: 'US', 161: 'US', 162: 'US',
  163: 'JP', 164: 'US', 165: 'US', 166: 'US', 167: 'US', 168: 'BR', 170: 'US', 171: 'JP', 172: 'US',
  173: 'US', 174: 'US', 175: 'KR', 176: 'RU', 177: 'BR', 178: 'RU', 179: 'BR', 180: 'CN', 181: 'BR',
  182: 'CN', 183: 'CN', 184: 'US', 185: 'DE', 186: 'BR', 187: 'BR', 188: 'RU', 189: 'BR', 190: 'BR',
  191: 'BR', 192: 'US', 193: 'DE', 194: 'FR', 195: 'NL', 196: 'ZA', 197: 'EG', 198: 'US', 199: 'US',
  200: 'BR', 201: 'BR', 202: 'JP', 203: 'AU', 204: 'US', 205: 'US', 206: 'US', 207: 'US', 208: 'US',
  209: 'US', 210: 'JP', 211: 'KR', 212: 'DE', 213: 'FR', 216: 'US', 217: 'RU', 218: 'CN', 219: 'JP',
  220: 'JP', 221: 'CN', 222: 'CN', 223: 'CN'
};

// In-memory LRU / lookup cache
const GEO_CACHE = new Map();
const PENDING_LOOKUPS = new Set();

/**
 * Searches the sorted RANGE_DATABASE using binary search.
 */
function findInRanges(ipInt) {
  let low = 0;
  let high = RANGE_DATABASE.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const [start, end, cc] = RANGE_DATABASE[mid];
    if (ipInt >= start && ipInt <= end) {
      return cc;
    }
    if (ipInt < start) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return null;
}

/**
 * Resolves country information for an IP string.
 * Completely synchronous and non-blocking with instant offline fallback.
 */
function lookup(rawIp) {
  const ip = cleanIp(rawIp);
  if (!ip) {
    return {
      ip: '',
      countryCode: 'XX',
      countryName: 'Unknown',
      flag: '🌐'
    };
  }

  // Check in-memory cache first
  if (GEO_CACHE.has(ip)) {
    return GEO_CACHE.get(ip);
  }

  // Handle local / private LAN / loopback addresses
  if (isPrivateIp(ip)) {
    const isLoop = ip.startsWith('127.') || ip === 'localhost' || ip === '::1';
    const result = {
      ip: ip,
      countryCode: 'LAN',
      countryName: isLoop ? 'Localhost' : 'Local Network',
      flag: '🏠'
    };
    GEO_CACHE.set(ip, result);
    return result;
  }

  const intVal = ipToInt(ip);
  let countryCode = null;

  if (intVal !== null) {
    // 1. Check granular CIDR ranges
    countryCode = findInRanges(intVal);

    // 2. Check /8 regional fallback if not matched in specific subnets
    if (!countryCode) {
      const firstOctet = intVal >>> 24;
      countryCode = REGIONAL_8_FALLBACK[firstOctet] || null;
    }
  }

  if (!countryCode) {
    countryCode = 'XX';
  }

  const countryName = COUNTRY_NAMES[countryCode] || (countryCode === 'XX' ? 'Unknown' : countryCode);
  const flag = countryCodeToFlag(countryCode);

  const result = {
    ip: ip,
    countryCode: countryCode,
    countryName: countryName,
    flag: flag
  };

  GEO_CACHE.set(ip, result);

  // Optional background online enrichment for unmapped or generic addresses
  if ((countryCode === 'XX' || !COUNTRY_NAMES[countryCode]) && !PENDING_LOOKUPS.has(ip)) {
    scheduleOnlineEnrichment(ip);
  }

  return result;
}

/**
 * Asynchronously checks a lightweight public GeoIP endpoint without blocking the engine.
 */
function scheduleOnlineEnrichment(ip) {
  if (PENDING_LOOKUPS.size > 200) return;
  PENDING_LOOKUPS.add(ip);

  const req = https.get(`https://api.country.is/${ip}`, { timeout: 1500 }, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      PENDING_LOOKUPS.delete(ip);
      try {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          if (parsed && parsed.country && parsed.country.length === 2) {
            const cc = parsed.country.toUpperCase();
            GEO_CACHE.set(ip, {
              ip: ip,
              countryCode: cc,
              countryName: COUNTRY_NAMES[cc] || cc,
              flag: countryCodeToFlag(cc)
            });
          }
        }
      } catch (e) {}
    });
  });

  req.on('error', () => {
    PENDING_LOOKUPS.delete(ip);
  });
  req.on('timeout', () => {
    req.destroy();
    PENDING_LOOKUPS.delete(ip);
  });
}

module.exports = {
  lookup,
  countryCodeToFlag,
  cleanIp,
  ipToInt,
  isPrivateIp,
  COUNTRY_NAMES
};
