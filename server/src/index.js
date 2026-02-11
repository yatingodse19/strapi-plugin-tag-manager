'use strict';

const register = ({ strapi }) => {
  strapi.customFields.register({
    name: 'tags',
    plugin: 'tag-manager',
    type: 'json',
  });
};

const config = {
  default: {
    tagContentType: 'api::tag.tag',
  },
  validator: (config) => {
    if (config.tagContentType && typeof config.tagContentType !== 'string') {
      throw new Error('tag-manager: tagContentType must be a string (e.g. "api::tag.tag")');
    }
  },
};

const controllers = require('./controllers');
const routes = require('./routes');

module.exports = {
  register,
  config,
  controllers,
  routes,
};
