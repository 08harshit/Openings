/**
 * Curated names of well-known tech/product companies with active engineering
 * hubs in major Indian cities, spanning Bangalore, Hyderabad, Pune, Mumbai,
 * Delhi-NCR/Gurgaon, and Chennai.
 *
 * Why this exists alongside `COMPANY_DISCOVERY_QUERIES`: organic search-based
 * discovery is noisy by nature — most hits are job aggregators or generic
 * listicles, not company names (see CompanyResolverService's blocklist,
 * grown from exactly this noise). A curated seed list gives the same
 * zero-manual-URL resolver (ATS slug guess -> homepage/career-page search) a
 * much higher hit rate to work with, and most of these run on Greenhouse/
 * Lever/Ashby, so they typically resolve via the free ATS path without
 * spending any Firecrawl credits at all. Edit freely — being wrong about a
 * name here just costs one resolution attempt, not a bad result, since every
 * name still goes through the same verified resolver as an organic hit.
 */
export const INDIA_SEED_COMPANIES: string[] = [
  // Bangalore
  'Razorpay', 'Zerodha', 'Postman', 'Cred', 'Meesho', 'Swiggy', 'PhonePe',
  'Groww', 'Slice', 'BrowserStack', 'Whatfix', 'Innovaccer', 'Hasura',
  'MoEngage', 'Clevertap', 'ShareChat', 'Urban Company', 'Yellow.ai',
  'Observe.AI', 'Juspay', 'Simpl', 'Khatabook', 'Vedantu', 'Unacademy',
  'Testbook', 'Rippling', 'Netskope', 'Gupshup', 'Wingify', 'Freshworks',
  'Zoho', 'Chargebee', 'Darwinbox', 'Uniphore', 'Licious', 'Cure.fit',

  // Hyderabad
  'Pharmeasy', 'SirionLabs', 'ValueLabs', 'Cyient', 'Deltek',

  // Pune
  'Persistent Systems', 'KPIT Technologies', 'Zensar Technologies',

  // Mumbai
  'Dream11', 'upGrad', 'Angel One', 'Zepto', 'CoinDCX',

  // Delhi NCR / Gurgaon / Noida
  'PolicyBazaar', 'Paytm', 'Zomato', 'Lenskart', 'CarDekho', 'Nykaa',
  'Spinny', 'Info Edge', 'MakeMyTrip', 'CarTrade',
];
