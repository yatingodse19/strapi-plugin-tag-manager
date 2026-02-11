'use strict';

module.exports = [
  {
    method: 'GET',
    path: '/config',
    handler: 'config.getConfig',
    config: {
      policies: ['admin::isAuthenticatedAdmin'],
    },
  },
];
