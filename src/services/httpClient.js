/**
 * Axios HTTP Client Service
 * Centralized HTTP client with interceptors, error handling, and logging
 */

import axios from 'axios';
import apiConfig from '../config/apiConfig';
import logger from './logger';
import { parseError, getErrorMessage } from './errorHandler';

// Create axios instance with default config
const axiosInstance = axios.create({
  baseURL: apiConfig.getBaseURL(),
  timeout: apiConfig.getTimeout(),
  headers: apiConfig.getDefaultHeaders(),
});

// Log the baseURL for debugging
console.log(`[HTTP_CLIENT] Axios baseURL configured as: ${axiosInstance.defaults.baseURL}`);

/**
 * Request interceptor
 * - Log outgoing requests
 * - Add authentication tokens if available
 */
axiosInstance.interceptors.request.use(
  (config) => {
    const startTime = performance.now();
    config.metadata = { startTime };

    logger.debug(`[REQUEST] ${config.method.toUpperCase()} ${config.url}`);

    // Add auth token if available
    const token = localStorage.getItem('authToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
  },
  (error) => {
    logger.error('Request interceptor error', error);
    return Promise.reject(error);
  }
);

/**
 * Response interceptor
 * - Calculate request duration
 * - Log responses
 * - Handle errors globally
 */
axiosInstance.interceptors.response.use(
  (response) => {
    const duration = Math.round(performance.now() - response.config.metadata.startTime);
    logger.logApiCall(
      response.config.method.toUpperCase(),
      response.config.url,
      response.status,
      duration
    );
    return response;
  },
  (error) => {
    if (error.config?.metadata?.startTime) {
      const duration = Math.round(performance.now() - error.config.metadata.startTime);
      const status = error.response?.status || 0;
      logger.logApiCall(
        error.config.method.toUpperCase(),
        error.config.url,
        status,
        duration
      );
    }

    // Special handling for blob responses (e.g., PDF endpoints with errors)
    if (error.response?.data instanceof Blob) {
      console.log('[HTTP_CLIENT] Blob error detected, size:', error.response.data.size);
      // Keep the blob as-is for the component to handle with FileReader
      error.isBlobError = true;
    }

    const parsedError = parseError(error);
    
    // Log with just the key error info to avoid [Object] in console
    logger.error(`[ERROR] ${error.config?.url || 'unknown'}: ${parsedError.message}`, {
      status: parsedError.status,
      message: parsedError.message,
      isNetworkError: parsedError.isNetworkError,
      isTimeout: parsedError.isTimeout,
      isServerError: parsedError.isServerError,
      isBlobError: error.isBlobError
    });

    // Enrich error with user-friendly message
    error.userMessage = getErrorMessage(parsedError);
    error.parsedError = parsedError;

    return Promise.reject(error);
  }
);

/**
 * Helper methods for common HTTP operations
 */
export const http = {
  get: (url, config) => axiosInstance.get(url, config),
  post: (url, data, config) => axiosInstance.post(url, data, config),
  put: (url, data, config) => axiosInstance.put(url, data, config),
  patch: (url, data, config) => axiosInstance.patch(url, data, config),
  delete: (url, config) => axiosInstance.delete(url, config),
};

export default axiosInstance;
