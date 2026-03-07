const appJson = require('./app.json');

const experimentVariant = process.env.EXPERIMENT_VARIANT ?? 'medium';

module.exports = {
  ...appJson,
  expo: {
    ...appJson.expo,
    extra: {
      ...(appJson.expo.extra ?? {}),
      experimentVariant,
    },
  },
};
