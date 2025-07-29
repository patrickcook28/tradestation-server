'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'show_tooltips', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true
    });

    // Create index for performance
    await queryInterface.addIndex('users', ['show_tooltips']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('users', ['show_tooltips']);
    await queryInterface.removeColumn('users', 'show_tooltips');
  }
}; 