import { _mock } from './_mock';

// ----------------------------------------------------------------------

export const _carouselsMembers = Array.from({ length: 6 }, (_, index) => ({
  id: _mock.id(index),
  name: _mock.fullName(index),
  role: _mock.role(index),
  avatarUrl: _mock.image.portrait(index),
}));

// ----------------------------------------------------------------------

export const _faqs = Array.from({ length: 8 }, (_, index) => ({
  id: _mock.id(index),
  value: `panel${index + 1}`,
  title: `Questions ${index + 1}`,
  content: _mock.description(index),
}));

// ----------------------------------------------------------------------

export const _addressBooks = Array.from({ length: 24 }, (_, index) => ({
  id: _mock.id(index),
  primary: index === 0,
  name: _mock.fullName(index),
  email: _mock.email(index + 1),
  fullAddress: _mock.fullAddress(index),
  phoneNumber: _mock.phoneNumber(index),
  company: _mock.companyNames(index + 1),
  addressType: index === 0 ? 'Home' : 'Office',
}));

// ----------------------------------------------------------------------

const PEPE_NAMES = [
  'GigaPepe 🦾', 'Elon Frog 🚀', 'Wizard Pepe 🧙', 'Gold Emperor Pepe 👑',
  'Diamond Hands Frog 💎', 'DeFi Farmer Frog 🚜', 'Leverage Master Pepe ⚡',
  'Green Whale Alpha 🐋', 'Moon Shot Pepe 🌙', 'LaserEyes Frog 🔴',
  'Safu Guard Pepe 🛡️', 'Meme Lord Frog 🎭', 'Alpha Caller Pepe 📞',
  'Rich Merchant Pepe 💼', 'Smart Copier Frog 🤝', 'Green Green Grass Pepe 🌱',
  'Super Saiyan Pepe ⚡', 'Cybernetic Cyborg Frog 🤖', 'Green Sovereign 👑', 'Pepe the Great 🐸'
];

export const _contacts = Array.from({ length: 20 }, (_, index) => {
  const status =
    (index % 2 && 'online') || (index % 3 && 'offline') || (index % 4 && 'always') || 'busy';

  return {
    id: _mock.id(index),
    status,
    role: index % 2 === 0 ? 'Star Trader' : 'Copier',
    email: `${PEPE_NAMES[index].toLowerCase().replace(/[^a-z0-9]/g, '')}@pepefi.io`,
    name: PEPE_NAMES[index],
    phoneNumber: _mock.phoneNumber(index),
    lastActivity: _mock.time(index),
    avatarUrl: index % 2 === 0 ? '/avatars/pepe-01.png' : '/assets/images/pepefi/pepe_eth.jpg',
    address: _mock.fullAddress(index),
  };
});

// ----------------------------------------------------------------------

const PEPE_NOTIFS = [
  {
    title: '<p><strong>GigaPepe 🦾</strong> sent you a copy-trade follow request!</p>',
    type: 'friend',
    category: 'SocialFi'
  },
  {
    title: '<p><strong>Elon Frog 🚀</strong> paired with you! You both earned <strong>200 PEPE</strong> copy rewards! 🤝</p>',
    type: 'project',
    category: 'SocialFi'
  },
  {
    title: '<p>🧪 Your <strong>Golden Elixir (黃金仙露)</strong> purchase was successful! (-300 PEPE)</p>',
    type: 'file',
    category: 'GameFi'
  },
  {
    title: '<p>🐣 孵化成功！您的繁育蛋誕生了一隻 <strong>Supreme Space Lord 🌌</strong> 傳奇佩佩！</p>',
    type: 'tags',
    category: 'GameFi'
  },
  {
    title: '<p>💰 <strong>Whale Alert</strong>: A copy whale just locked <strong>$50,000 USDC</strong> to follow your strategy!</p>',
    type: 'payment',
    category: 'SocialFi'
  },
  {
    title: '<p>📅 <strong>每日簽到提醒</strong>：您今天還沒簽到喔！點擊去領取今日 <strong>+50 PEPE</strong> 激勵！</p>',
    type: 'order',
    category: 'MemeFi'
  },
  {
    title: '<p>📈 您的交易量突破等級閾值，成功解鎖 <strong>Gold 🥇</strong> 等級，並獲得一次性獎勵 10,000 PEPE！</p>',
    type: 'delivery',
    category: 'MemeFi'
  },
  {
    title: '<p>⛏️ 您開倉的槓桿交易頭寸已累積可申領 <strong>4,200 PEPE</strong> 交易挖礦獎勵！</p>',
    type: 'chat',
    category: 'DeFi'
  },
  {
    title: '<p>🛡️ Insurance Vault has fully rebalanced! Platform risk index is extremely low & SAFU.</p>',
    type: 'mail',
    category: 'DeFi'
  }
];

export const _notifications = Array.from({ length: 9 }, (_, index) => ({
  id: _mock.id(index),
  avatarUrl: index % 2 === 0 ? '/avatars/pepe-01.png' : '/assets/images/pepefi/pepe_eth.jpg',
  type: PEPE_NOTIFS[index].type,
  category: PEPE_NOTIFS[index].category,
  isUnRead: index < 3,
  createdAt: _mock.time(index),
  title: PEPE_NOTIFS[index].title,
}));

// ----------------------------------------------------------------------

export const _mapContact = [
  { latlng: [33, 65], address: _mock.fullAddress(1), phoneNumber: _mock.phoneNumber(1) },
  { latlng: [-12.5, 18.5], address: _mock.fullAddress(2), phoneNumber: _mock.phoneNumber(2) },
];

// ----------------------------------------------------------------------

export const _socials = [
  {
    value: 'facebook',
    label: 'Facebook',
    path: 'https://www.facebook.com/caitlyn.kerluke',
  },
  {
    value: 'instagram',
    label: 'Instagram',
    path: 'https://www.instagram.com/caitlyn.kerluke',
  },
  {
    value: 'linkedin',
    label: 'Linkedin',
    path: 'https://www.linkedin.com/caitlyn.kerluke',
  },
  {
    value: 'twitter',
    label: 'Twitter',
    path: 'https://www.twitter.com/caitlyn.kerluke',
  },
];

// ----------------------------------------------------------------------

export const _pricingPlans = [
  {
    subscription: 'basic',
    price: 0,
    caption: 'Forever',
    lists: ['3 prototypes', '3 boards', 'Up to 5 team members'],
    labelAction: 'Current plan',
  },
  {
    subscription: 'starter',
    price: 4.99,
    caption: 'Saving $24 a year',
    lists: [
      '3 prototypes',
      '3 boards',
      'Up to 5 team members',
      'Advanced security',
      'Issue escalation',
    ],
    labelAction: 'Choose starter',
  },
  {
    subscription: 'premium',
    price: 9.99,
    caption: 'Saving $124 a year',
    lists: [
      '3 prototypes',
      '3 boards',
      'Up to 5 team members',
      'Advanced security',
      'Issue escalation',
      'Issue development license',
      'Permissions & workflows',
    ],
    labelAction: 'Choose premium',
  },
];

// ----------------------------------------------------------------------

export const _testimonials = [
  {
    name: _mock.fullName(1),
    postedDate: _mock.time(1),
    ratingNumber: _mock.number.rating(1),
    avatarUrl: _mock.image.avatar(1),
    content: `Excellent Work! Thanks a lot!`,
  },
  {
    name: _mock.fullName(2),
    postedDate: _mock.time(2),
    ratingNumber: _mock.number.rating(2),
    avatarUrl: _mock.image.avatar(2),
    content: `It's a very good dashboard and we are really liking the product . We've done some things, like migrate to TS and implementing a react useContext api, to fit our job methodology but the product is one of the best in terms of design and application architecture. The team did a really good job.`,
  },
  {
    name: _mock.fullName(3),
    postedDate: _mock.time(3),
    ratingNumber: _mock.number.rating(3),
    avatarUrl: _mock.image.avatar(3),
    content: `Customer support is realy fast and helpful the desgin of this theme is looks amazing also the code is very clean and readble realy good job !`,
  },
  {
    name: _mock.fullName(4),
    postedDate: _mock.time(4),
    ratingNumber: _mock.number.rating(4),
    avatarUrl: _mock.image.avatar(4),
    content: `Amazing, really good code quality and gives you a lot of examples for implementations.`,
  },
  {
    name: _mock.fullName(5),
    postedDate: _mock.time(5),
    ratingNumber: _mock.number.rating(5),
    avatarUrl: _mock.image.avatar(5),
    content: `Got a few questions after purchasing the product. The owner responded very fast and very helpfull. Overall the code is excellent and works very good. 5/5 stars!`,
  },
  {
    name: _mock.fullName(6),
    postedDate: _mock.time(6),
    ratingNumber: _mock.number.rating(6),
    avatarUrl: _mock.image.avatar(6),
    content: `CEO of Codealy.io here. We’ve built a developer assessment platform that makes sense - tasks are based on git repositories and run in virtual machines. We automate the pain points - storing candidates code, running it and sharing test results with the whole team, remotely. Bought this template as we need to provide an awesome dashboard for our early customers. I am super happy with purchase. The code is just as good as the design. Thanks!`,
  },
];
