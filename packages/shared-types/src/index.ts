export type HealthStatus = {
  status: 'ok';
  service: string;
  database: 'configured' | 'disabled';
  timestamp: string;
};
