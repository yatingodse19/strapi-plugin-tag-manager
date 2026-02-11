const pluginId = 'tag-manager';

export default {
  register(app: any) {
    app.customFields.register({
      name: 'tags',
      pluginId,
      type: 'text',
      intlLabel: {
        id: `${pluginId}.form.label`,
        defaultMessage: 'Tag Manager',
      },
      intlDescription: {
        id: `${pluginId}.form.description`,
        defaultMessage: 'Manage tags with autocomplete and auto-creation',
      },
      components: {
        Input: async () => import('./components/TagManagerInput'),
      },
    });
  },
};
