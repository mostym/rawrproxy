import { useRef, useCallback, useEffect } from 'react';
import { toast } from 'react-hot-toast';

export function useWebSocket() {
  const ws = useRef(null);
  const reconnectTimer = useRef(null);
  const callbacks = useRef({});

  const connect = useCallback((url, options = {}) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      ws.current = new WebSocket(url);
      
      ws.current.onopen = () => {
        console.log('WebSocket connected');
        toast.success('Connected to real-time updates');
        if (options.onOpen) options.onOpen();
      };

      ws.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (options.onMessage) options.onMessage(data);
          
          // Call registered callbacks
          if (callbacks.current[data.type]) {
            callbacks.current[data.type](data.payload);
          }
        } catch (error) {
          console.error('WebSocket message parse error:', error);
        }
      };

      ws.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        if (options.onError) options.onError(error);
      };

      ws.current.onclose = () => {
        console.log('WebSocket disconnected');
        toast.error('Disconnected from real-time updates');
        if (options.onClose) options.onClose();
        
        // Auto-reconnect after 5 seconds
        reconnectTimer.current = setTimeout(() => {
          connect(url, options);
        }, 5000);
      };
    } catch (error) {
      console.error('WebSocket connection error:', error);
      toast.error('Failed to connect to real-time updates');
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
  }, []);

  const send = useCallback((data) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket is not connected');
    }
  }, []);

  const subscribe = useCallback((type, callback) => {
    callbacks.current[type] = callback;
    
    return () => {
      delete callbacks.current[type];
    };
  }, []);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    connect,
    disconnect,
    send,
    subscribe,
    isConnected: ws.current?.readyState === WebSocket.OPEN,
  };
}