/**
 * Centralized table & column name constants — single source of truth so we
 * never typo a Supabase identifier across handlers.
 */

'use strict';

module.exports = Object.freeze({
  T: Object.freeze({
    coffee_varieties:           'coffee_varieties',
    coffee_references:          'coffee_references',
    coffee_reference_varieties: 'coffee_reference_varieties',
    process_lead_times:         'process_lead_times',
    demand_orders:              'demand_orders',
    demand_order_varieties:     'demand_order_varieties',
    production_lots:            'production_lots',
    production_lot_varieties:   'production_lot_varieties',
    lot_order_assignments:      'lot_order_assignments',
    email_log:                  'email_log',
  }),
  ORDER_STATUS: Object.freeze({
    Pending:           'Pending',
    Accepted:          'Accepted',
    PartiallyAccepted: 'PartiallyAccepted',
    Rejected:          'Rejected',
    InProduction:      'InProduction',
    Completed:         'Completed',
    Cancelled:         'Cancelled',
  }),
  LOT_STATUS: Object.freeze({
    InFermentation: 'InFermentation',
    Drying:         'Drying',
    Resting:        'Resting',
    Ready:          'Ready',
    Delivered:      'Delivered',
  }),
  PROCESS_TYPES: Object.freeze(['Natural', 'Honey', 'Lavado']),
  PHYSICAL_ASPECTS: Object.freeze(['Verde', 'Verde amarillo', 'Amarillo', 'Amarillo-Marrón', 'Parduzco']),
  ROLES: Object.freeze(['forest', 'finca', 'admin']),
});
