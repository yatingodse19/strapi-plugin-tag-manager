'use strict';

module.exports = {
  config: {
    async getConfig(ctx) {
      const config = strapi.plugin('tag-manager').config;
      ctx.body = {
        tagContentType: config('tagContentType') || 'api::tag.tag',
      };
    },
  },
};
