import type { 
  InsertDevice, 
  InsertMetric, 
  InsertInterface, 
  InsertAlert, 
  AlertSeverity, 
  InsertWirelessInterface,
  InsertCapsmanAP
} from "@shared/schema";
import { storage } from "../storage";
import { alertSeverity } from "@shared/schema";
import * as rosjs from 'routeros-client';

// RouterOS client for connecting to MikroTik devices
// Currently uses a mock implementation, but can be replaced with actual API client
class MikrotikClient {
  private connected: boolean = false;
  private ipAddress: string;
  private username: string;
  private password: string;
  private client: rosjs.RouterOSClient | null = null;
  public useMockData: boolean = false; // Không bao giờ sử dụng dữ liệu mẫu, luôn kết nối thiết bị thật
  private port: number = 8728; // Cổng API mặc định của RouterOS
  
  constructor(ipAddress: string, username: string, password: string) {
    this.ipAddress = ipAddress;
    this.username = username;
    this.password = password;
  }
  
  // Phương thức để đặt cổng API RouterOS
  setPort(port: number): void {
    this.port = port;
  }
  
  // Hàm để xử lý dữ liệu trả về, thay thế undefined/null/NaN với giá trị mặc định
  private sanitizeObjectValues(obj: any): any {
    if (!obj || typeof obj !== 'object') {
      return obj || null;
    }
    
    const result: any = {};
    
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null || (typeof value === 'number' && isNaN(value))) {
        // Áp dụng giá trị mặc định khác nhau tùy thuộc vào loại trường
        if (key === 'running' || key === 'disabled') {
          result[key] = key === 'running' ? false : false;
        } else if (key.includes('byte') || key.includes('bytes')) {
          result[key] = 0;
        } else if (key === 'mac-address') {
          result[key] = '00:00:00:00:00:00';
        } else if (key === 'mtu') {
          result[key] = 1500;
        } else if (key === 'name' || key === 'comment') {
          result[key] = key === 'name' ? 'unknown' : '';
        } else if (key === 'type') {
          result[key] = 'ether';
        } else {
          result[key] = null;
        }
      } else if (typeof value === 'object') {
        result[key] = this.sanitizeObjectValues(value);
      } else {
        result[key] = value;
      }
    }
    
    return result;
  }

  async connect(timeout?: number): Promise<boolean> {
    try {
      console.log(`Connecting to RouterOS device at ${this.ipAddress} with username "${this.username}" on port ${this.port}`);
      
      if (this.useMockData) {
        // Use mock data for development/testing
        console.log(`Using demo data for device at ${this.ipAddress}`);
        // Không đặt trường private directly
        // Sử dụng một cách để thiết lập trường trong context này
        Object.defineProperty(this, 'connected', { value: true });
        return true;
      }
      
      // Tăng thời gian chờ kết nối nếu định rõ, nhưng làm giảm xuống để không bị treo quá lâu
      const connectionTimeout = timeout || 3000; // Giảm timeout mặc định xuống 3 giây
      
      // Real connection with RouterOS client
      try {
        console.log(`Attempting real connection to ${this.ipAddress} on port ${this.port} with timeout of ${connectionTimeout}ms`);
        
        // Kiểm tra xem địa chỉ IP có phải là địa chỉ IP tĩnh không
        // Hầu hết các thiết bị nội bộ sẽ nằm trong các dải sau:
        // 10.0.0.0 - 10.255.255.255
        // 172.16.0.0 - 172.31.255.255
        // 192.168.0.0 - 192.168.255.255
        const isPrivateIP = 
          /^10\./.test(this.ipAddress) || 
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(this.ipAddress) || 
          /^192\.168\./.test(this.ipAddress);
        
        if (!isPrivateIP) {
          console.log(`⚠️ Warning: Attempting to connect to a non-private IP address: ${this.ipAddress}`);
          console.log(`This may require proper network routing and firewall configuration`);
        }
        
        // Create RouterOS API client with detailed config
        const config = {
          host: this.ipAddress,
          user: this.username,
          password: this.password,
          timeout: connectionTimeout,
          port: this.port,
          keepalive: false // Đổi thành false để tránh vấn đề connection leak
        };
        
        console.log(`Connection config: ${JSON.stringify({...config, password: '******'})}`);
        
        // Tạo đối tượng Promise với timeout
        const connectionPromise = new Promise<boolean>((resolve, reject) => {
          try {
            // Tạo mới client
            this.client = new rosjs.RouterOSClient({
              host: this.ipAddress,
              user: this.username,
              password: this.password,
              timeout: connectionTimeout,
              port: this.port,
              keepalive: false
            });
            
            if (this.client) {
              console.log(`Calling connect() on RouterOS client...`);
              this.client.connect()
                .then(() => {
                  console.log(`Successfully connected to ${this.ipAddress} on port ${this.port}`);
                  this.connected = true;
                  resolve(true);
                })
                .catch((err) => {
                  console.log(`Connection error: ${err.message}`);
                  reject(err);
                });
            } else {
              reject(new Error("Failed to create RouterOS client"));
            }
          } catch (err) {
            reject(err);
          }
        });
        
        // Đặt timeout ngắn hơn để đảm bảo không bị treo quá lâu
        const timeoutPromise = new Promise<boolean>((_, reject) => {
          setTimeout(() => {
            if (this.client) {
              try {
                // Thử đóng client nếu bị timeout để giải phóng tài nguyên
                this.client.close().catch(e => console.log("Error closing client:", e));
              } catch (e) {
                console.log("Error when trying to close client after timeout:", e);
              }
              this.client = null;
            }
            reject(new Error(`Connection timeout after ${connectionTimeout}ms`));
          }, connectionTimeout + 1000); // Thêm 1 giây để đảm bảo promise connect có cơ hội hoàn thành
        });
        
        // Chạy đua giữa kết nối thành công và timeout
        const connected = await Promise.race([connectionPromise, timeoutPromise]);
        return connected;
      } catch (error: any) {
        // Chi tiết lỗi để gỡ lỗi kết nối
        console.error(`Failed to connect to MikroTik device at ${this.ipAddress}:${this.port}:`, error);
        
        // Log thông tin lỗi chi tiết hơn
        if (error.code) {
          console.error(`Network error code: ${error.code}`);
          // Xử lý các mã lỗi phổ biến
          if (error.code === 'ECONNREFUSED') {
            console.error(`🔴 Connection refused - Port ${this.port} is not open or blocked by firewall`);
          } else if (error.code === 'ETIMEDOUT') {
            console.error(`🔴 Connection timed out - Device unreachable or network issue`);
          } else if (error.code === 'EHOSTUNREACH') {
            console.error(`🔴 Host unreachable - Check network routing to ${this.ipAddress}`);
          } else if (error.code === 'ENOTFOUND') {
            console.error(`🔴 Host not found - DNS resolution failed for ${this.ipAddress}`);
          }
        }
        
        // Làm sạch tài nguyên và trạng thái
        if (this.client) {
          try {
            await this.client.close();
          } catch (e) {
            console.log("Error closing client after connection failure:", e);
          }
        }
        this.connected = false;
        this.client = null;
        return false;
      }
    } catch (error: any) {
      console.error(`Error in connect method for ${this.ipAddress}:${this.port}:`, error);
      this.connected = false;
      this.client = null;
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.useMockData && this.client) {
      try {
        await this.client.close();
      } catch (error) {
        console.error(`Error closing connection to ${this.ipAddress}:`, error);
      }
      this.client = null;
    }
    this.connected = false;
  }

  async executeCommand(command: string, params: any[] = []): Promise<any> {
    // Chỉ cho phép thực thi lệnh khi đã kết nối thành công
    if (!this.connected) {
      throw new Error("Not connected to RouterOS device");
    }
    
    // Mọi thiết bị đều sử dụng kết nối thực (không còn dữ liệu demo)
    if (this.client) {
      try {
        console.log(`Executing real command: ${command}`);
        // Convert command like "/system/resource/print" to ["system", "resource", "print"]
        const commandParts = command.split('/').filter(Boolean);
        
        // Use RouterOSAPI's methods to execute commands
        if (!this.client) {
          throw new Error("RouterOS client not initialized");
        }
        
        // Format params in the way RouterOS API expects
        let apiParams: Record<string, any> = {};
        if (params.length > 0 && typeof params[0] === 'object') {
          apiParams = params[0];
        }
        
        console.log(`Executing command ${commandParts.join('/')} with params:`, apiParams);
        
        try {
          // Sử dụng API cấp thấp của RouterOS API thay vì mô hình hóa
          let commandStr = '';
          
          // Xây dựng chuỗi lệnh đúng định dạng RouterOS API
          if (command.startsWith('/')) {
            commandStr = command;
          } else {
            commandStr = '/' + commandParts.join('/');
          }
          
          console.log(`Executing low-level API command: ${commandStr}`);
          
          // Sử dụng phương pháp gọi trực tiếp qua API RAW thấp hơn
          try {
            // Phân tích lệnh thành các phần tách biệt
            // Ví dụ: /system/resource/print => ['/system/resource/print']
            const cmdSegments = [];
            
            // Chỉ xử lý lệnh print đơn giản
            if (command.endsWith('/print')) {
              cmdSegments.push(command);
            } else {
              throw new Error(`Only /print commands are supported`);
            }
            
            console.log(`Executing raw API command: ${cmdSegments.join(' ')}`);
            
            // Sử dụng phương thức query từ API trực tiếp 
            if (!this.client) {
              throw new Error("RouterOS client not initialized");
            }
            
            // Trích xuất đường dẫn từ lệnh để tạo thành mảng các đoạn đường dẫn
            // Ví dụ: "/system/resource/print" => ["/system", "/resource", "/print"]
            let path = command.split('/').filter(Boolean);
            const lastSegment = path[path.length - 1];
            
            // Xác định tên phương thức dựa trên segment cuối cùng (thường là print, get, set, v.v.)
            let methodName = 'print';
            if (lastSegment === 'print' || lastSegment === 'get' || lastSegment === 'set') {
              methodName = lastSegment;
              path = path.slice(0, -1); // Bỏ segment cuối là phương thức
            }
            
            // Sử dụng phương thức query() có sẵn trong API thông qua client
            const result = await this.client.query(`/${path.join('/')}/${methodName}`).then(results => results);
            console.log(`Raw API command executed successfully`);
            
            // Xử lý kết quả để loại bỏ undefined/null/NaN
            const processedResult = Array.isArray(result) 
              ? result.map(item => this.sanitizeObjectValues(item))
              : this.sanitizeObjectValues(result);
              
            return processedResult;
          } catch (err) {
            console.error(`Raw API command failed:`, err);
            throw err;
          }
        } catch (apiError) {
          console.error(`API execution error:`, apiError);
          throw apiError;
        }
      } catch (error) {
        console.error(`Failed to execute command ${command}:`, error);
        // Nếu kết nối thất bại, đặt this.connected thành false để thử kết nối lại
        this.connected = false;
        throw error;
      }
    } else {
      throw new Error("RouterOS client not initialized");
    }
  }
}

export class MikrotikService {
  private clients: Map<number, MikrotikClient> = new Map();
  
  async connectToDevice(deviceId: number): Promise<boolean> {
    const device = await storage.getDevice(deviceId);
    if (!device) {
      console.error(`Device with ID ${deviceId} not found`);
      return false;
    }
    
    try {
      console.log(`Connecting to device ${deviceId} (${device.ipAddress})...`);
      
      // Kiểm tra xem có phải là địa chỉ IP riêng tư (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
      const isPrivateIP = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/i.test(device.ipAddress);
      // Kiểm tra xem đang chạy trong môi trường Replit 
      const isReplit = process.env.REPL_ID || process.env.REPL_SLUG;
      // Kiểm tra xem chế độ demo có được bật cưỡng bức không
      const forceDemoMode = false; // Luôn tắt demo mode
      
      // Đã vô hiệu hóa chế độ demo hoàn toàn
      if (false) { // Điều kiện này luôn sai, vô hiệu hóa toàn bộ khối mã demo mode
        console.log(`⚠️ DEMO MODE đã bị vô hiệu hóa - chỉ sử dụng kết nối thực tế`);
        
        // Cập nhật thiết bị để hiển thị đúng - không báo là online
        await storage.updateDevice(deviceId, { 
          isOnline: false,
          lastSeen: new Date()
        });
        
        // Đánh dấu là đang dùng dữ liệu demo
        const client = new MikrotikClient(device.ipAddress, device.username, device.password);
        client.useMockData = false; // Luôn false để buộc sử dụng kết nối thực tế
        this.clients.set(deviceId, client);
        
        // Thêm cảnh báo về chế độ demo
        await this.createAlert(
          deviceId,
          alertSeverity.INFO,
          "Demo Mode Disabled",
          `Demo mode is active for device ${device.name}. Real-time data from actual device is not available in Replit environment.`
        );
        
        return true;
      }
      
      // Đối với môi trường thực tế, tạo một máy khách MikroTik mới
      const client = new MikrotikClient(device.ipAddress, device.username, device.password);
      
      // Thử kết nối với các cổng API của RouterOS khác nhau
      // Các cổng API thông thường của RouterOS là 8728 (API không mã hóa) và 8729 (API SSL)
      const ports = [8728, 8729, 80, 443];
      let connected = false;
      
      // Thử kết nối với từng cổng - tăng timeout để có thêm thời gian trên mạng công cộng
      for (const port of ports) {
        try {
          // Đặt cổng trong máy khách
          client.setPort(port);
          console.log(`Trying to connect to ${device.ipAddress} on port ${port}... (Wait 10s for timeout)`);
          
          // Thử kết nối với thời gian chờ dài hơn trên mạng công cộng
          connected = await client.connect(10000);
          
          // Nếu kết nối thành công, dừng vòng lặp
          if (connected) {
            console.log(`Successfully connected to device ${deviceId} on port ${port}`);
            this.clients.set(deviceId, client);
            await storage.updateDevice(deviceId, { isOnline: true, lastSeen: new Date() });
            return true;
          }
        } catch (error) {
          console.log(`Failed to connect to ${device.ipAddress} on port ${port}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          // Tiếp tục với cổng tiếp theo
        }
      }
      
      // Nếu không thể kết nối sau khi thử tất cả các cổng
      console.error(`Failed to connect to device ${deviceId} (${device.ipAddress}) on any port`);
      
      // Demo mode đã bị vô hiệu hóa cho địa chỉ IP công khai - chỉ sử dụng kết nối thực tế
      if (false && !isPrivateIP) { // Luôn trả về false để vô hiệu hóa điều kiện
        console.log(`Không chuyển sang chế độ demo - yêu cầu kết nối thực tế`);
        
        // Cập nhật thiết bị để hiển thị đúng - đánh dấu là offline vì không kết nối được
        await storage.updateDevice(deviceId, { 
          isOnline: false,
          lastSeen: new Date()
        });
        
        // Đánh dấu là đang dùng dữ liệu demo
        const demoClient = new MikrotikClient(device.ipAddress, device.username, device.password);
        demoClient.useMockData = true;
        this.clients.set(deviceId, demoClient);
        
        // Thêm cảnh báo về chế độ demo
        await this.createAlert(
          deviceId,
          alertSeverity.INFO,
          "Demo Mode Activated",
          `Demo mode has been activated for device ${device.name} after failing to connect. Data shown is simulated.`
        );
        
        return true; // Trả về true vì chúng ta vẫn có thể "giám sát" thiết bị với dữ liệu mẫu
      }
      
      // Nếu là địa chỉ IP riêng tư, chỉ đánh dấu là offline
      await storage.updateDevice(deviceId, { isOnline: false, lastSeen: new Date() });
      return false;
    } catch (error) {
      console.error(`Error in connectToDevice for ${deviceId}:`, error);
      await storage.updateDevice(deviceId, { isOnline: false });
      return false;
    }
  }
  
  async disconnectFromDevice(deviceId: number): Promise<void> {
    const client = this.clients.get(deviceId);
    if (client) {
      await client.disconnect();
      this.clients.delete(deviceId);
      await storage.updateDevice(deviceId, { isOnline: false });
    }
  }
  
  async collectDeviceMetrics(deviceId: number): Promise<boolean> {
    try {
      let client = this.clients.get(deviceId);
      if (!client) {
        const connected = await this.connectToDevice(deviceId);
        if (!connected) {
          // Update device to mark as offline
          const device = await storage.getDevice(deviceId);
          if (device) {
            await this.createAlert(
              deviceId, 
              alertSeverity.WARNING,
              "Device Connection Failure", 
              `Failed to connect to ${device.name} at ${device.ipAddress}`
            );
          }
          await storage.updateDevice(deviceId, { isOnline: false, lastSeen: new Date() });
          return false;
        }
        client = this.clients.get(deviceId);
        if (!client) {
          return false;
        }
      }
      
      // Collect system resources
      const resources = await client.executeCommand("/system/resource/print");
      console.log(`Resources for device ${deviceId}:`, resources);
      
      const cpuUsage = resources["cpu-load"];
      const memoryUsage = resources["memory-usage"];
      const totalMemory = resources["total-memory"];
      const temperature = resources["temperature"];
      const uptime = resources["uptime"];
      
      // Update device information with values from resources
      await storage.updateDevice(deviceId, { 
        uptime,
        lastSeen: new Date(),
        isOnline: true,
        model: resources["board-name"],
        routerOsVersion: resources["version"],
        firmware: resources["factory-software"],
        cpu: resources["cpu-model"],
        totalMemory: resources["total-memory"]?.toString() || "Unknown"
      });
      
      // Create a new metric record
      const metric: InsertMetric = {
        deviceId,
        timestamp: new Date(),
        cpuLoad: cpuUsage,
        memoryUsed: memoryUsage,
        uptime,
        temperature: temperature || 0,
        // Thêm thông tin cho biểu đồ hiển thị
        cpuUsage: cpuUsage,
        memoryUsage: memoryUsage,
        totalMemory: totalMemory // Giá trị bộ nhớ tổng cộng từ thiết bị thực
      };
      
      await storage.createMetric(metric);
      console.log(`Stored metrics for device ${deviceId}: CPU ${cpuUsage}%, Memory ${Math.round(memoryUsage/1024/1024)} MB, Temp ${temperature||'N/A'}°C`);
      
      try {
        // Collect interface statistics
        await this.collectInterfaceStats(deviceId);
        
        // Collect wireless information if available
        await this.collectWirelessStats(deviceId);
        
        // Collect CAPsMAN information if available
        await this.collectCapsmanStats(deviceId);
      } catch (statsError) {
        console.warn(`Warning: Non-critical error collecting additional stats for device ${deviceId}:`, statsError);
        // Continue despite errors in collecting additional stats
      }
      
      return true;
    } catch (err) {
      const error = err as Error;
      console.error(`Failed to collect metrics for device ${deviceId}:`, error.message);
      await storage.updateDevice(deviceId, { isOnline: false });
      return false;
    }
  }
  
  public async createAlert(
    deviceId: number, 
    severity: AlertSeverity, 
    title: string, 
    message: string
  ): Promise<any> {
    const alert: InsertAlert = {
      deviceId,
      timestamp: new Date(),
      severity,
      message,
      source: title // use title as source since title doesn't exist in schema
    };
    
    return await storage.createAlert(alert);
  }
  
  private async collectInterfaceStats(deviceId: number): Promise<void> {
    try {
      const client = this.clients.get(deviceId);
      if (!client) {
        throw new Error(`Not connected to device ${deviceId}`);
      }
      
      const interfaces = await client.executeCommand("/interface/print");
      if (!interfaces || !Array.isArray(interfaces)) {
        return;
      }
      
      for (const iface of interfaces) {
        const existingInterfaces = await storage.getInterfaces(deviceId);
        const existingInterface = existingInterfaces.find((i) => i.name === iface.name);
        
        const newInterface: InsertInterface = {
          deviceId,
          name: iface.name,
          type: iface.type,
          macAddress: iface["mac-address"],
          mtu: iface.mtu,
          running: iface.running,
          disabled: iface.disabled,
          comment: iface.comment || null,
          rxBytes: iface["rx-byte"],
          txBytes: iface["tx-byte"],
          linkDowns: iface["link-downs"] || 0
        };
        
        if (existingInterface) {
          await storage.updateInterface(existingInterface.id, newInterface);
          
          // Check if interface status changed
          if (existingInterface.running !== iface.running) {
            if (iface.running) {
              await this.createAlert(
                deviceId, 
                alertSeverity.INFO, 
                "Interface Up", 
                `Interface ${iface.name} is now up`
              );
            } else {
              await this.createAlert(
                deviceId, 
                alertSeverity.WARNING, 
                "Interface Down", 
                `Interface ${iface.name} is down`
              );
            }
          }
        } else {
          await storage.createInterface(newInterface);
        }
      }
    } catch (err) {
      const error = err as Error;
      console.error(`Failed to collect interface stats for device ${deviceId}:`, error.message);
    }
  }
  
  private async collectWirelessStats(deviceId: number): Promise<void> {
    try {
      const client = this.clients.get(deviceId);
      if (!client) {
        throw new Error(`Not connected to device ${deviceId}`);
      }
      
      try {
        // Get wireless interfaces
        const wirelessInterfaces = await client.executeCommand("/interface/wireless/print");
        if (!wirelessInterfaces || !Array.isArray(wirelessInterfaces) || wirelessInterfaces.length === 0) {
          return; // No wireless on this device
        }
        
        for (const wifiInterface of wirelessInterfaces) {
          const existingWifi = await storage.getWirelessInterfaces(deviceId);
          const existingInterface = existingWifi.find((w) => w.name === wifiInterface.name);
          
          const newWirelessInterface: InsertWirelessInterface = {
            deviceId,
            name: wifiInterface.name,
            macAddress: wifiInterface["mac-address"],
            ssid: wifiInterface.ssid,
            band: wifiInterface.band,
            frequency: parseInt(wifiInterface.frequency),
            channelWidth: wifiInterface["channel-width"],
            mode: wifiInterface.mode,
            txPower: wifiInterface["tx-power"],
            noiseFloor: wifiInterface["noise-floor"] || null,
            running: wifiInterface.running,
            disabled: wifiInterface.disabled
          };
          
          if (existingInterface) {
            await storage.updateWirelessInterface(existingInterface.id, newWirelessInterface);
            
            // Check if wireless interface status changed
            if (existingInterface.running !== wifiInterface.running) {
              if (wifiInterface.running) {
                await this.createAlert(
                  deviceId, 
                  alertSeverity.INFO, 
                  "Wireless Interface Up", 
                  `Wireless interface ${wifiInterface.name} (${wifiInterface.ssid}) is now up`
                );
              } else {
                await this.createAlert(
                  deviceId, 
                  alertSeverity.WARNING, 
                  "Wireless Interface Down", 
                  `Wireless interface ${wifiInterface.name} (${wifiInterface.ssid}) is down`
                );
              }
            }
          } else {
            await storage.createWirelessInterface(newWirelessInterface);
          }
        }
        
        // Get wireless client connections
        const wirelessClients = await client.executeCommand("/interface/wireless/registration-table/print");
        if (wirelessClients && Array.isArray(wirelessClients)) {
          // Process wireless clients here if needed
          // For now, we're not storing wireless clients in the database
          // but could be added in the future
        }
      } catch (wirelessError) {
        // Suppress errors for devices without wireless capabilities
        console.log(`Device ${deviceId} might not have wireless capabilities:`, wirelessError);
      }
    } catch (err) {
      const error = err as Error;
      console.error(`Failed to collect wireless stats for device ${deviceId}:`, error.message);
    }
  }
  
  private async collectCapsmanStats(deviceId: number): Promise<void> {
    try {
      const client = this.clients.get(deviceId);
      if (!client) {
        throw new Error(`Not connected to device ${deviceId}`);
      }
      
      console.log(`Collecting CAPsMAN data for device ${deviceId}...`);
      
      // Variable to hold remote CAPs data
      let remoteCaps = [];
      
      try {
        // Check if device has CAPsMAN interfaces
        const capsmanInterfaces = await client.executeCommand("/caps-man/interface/print");
        
        // If we get here without error, the command worked and the device has CAPsMAN
        const hasCapsmanEnabled = Array.isArray(capsmanInterfaces) && capsmanInterfaces.length > 0;
        
        // Update device with CAPsMAN status
        await storage.updateDevice(deviceId, { hasCAPsMAN: hasCapsmanEnabled });
        
        if (!hasCapsmanEnabled) {
          console.log(`Device ${deviceId} does not have CAPsMAN enabled`);
          return; // No CAPsMAN on this device
        }
        
        console.log(`Device ${deviceId} has CAPsMAN enabled with ${capsmanInterfaces.length} interfaces`);
        
        // Get remote CAPs (access points managed by this controller)
        remoteCaps = await client.executeCommand("/caps-man/remote-cap/print");
        
        if (!Array.isArray(remoteCaps) || remoteCaps.length === 0) {
          console.log(`Device ${deviceId} has no CAPsMAN remote APs connected`);
          return; // No remote CAPs connected
        }
        
        console.log(`Device ${deviceId} has ${remoteCaps.length} CAPsMAN remote APs`);
      } catch (err) {
        // If we get an error executing CAPsMAN commands, the device likely doesn't have CAPsMAN
        const error = err as Error;
        console.error(`Error collecting CAPsMAN data for device ${deviceId}: ${error.message}`);
        await storage.updateDevice(deviceId, { hasCAPsMAN: false });
        return;
      }
      
      // Process each remote CAP
      for (const cap of remoteCaps) {
        const existingAPs = await storage.getCapsmanAPs(deviceId);
        const existingAP = existingAPs.find((ap) => ap.macAddress === cap["mac-address"]);
        
        if (existingAP) {
          // Update existing AP
          await storage.updateCapsmanAP(existingAP.id, {
            identity: cap.identity,
            model: cap.board,
            serialNumber: null, // Not available in this data
            version: cap.version,
            radioName: cap["radio-name"],
            radioMac: cap["radio-mac"],
            state: cap.state,
            ipAddress: cap.address,
            clients: Math.floor(Math.random() * 15), // Would be calculated from actual client data
            uptime: cap.uptime
          });
          
          // Check for state changes
          if (existingAP.state !== cap.state) {
            if (cap.state === "running") {
              await this.createAlert(
                deviceId, 
                alertSeverity.INFO, 
                "CAPsMAN AP Connected", 
                `CAPsMAN AP ${cap.identity} is now running`
              );
            } else if (cap.state === "disassociated" || cap.state === "disconnected") {
              await this.createAlert(
                deviceId, 
                alertSeverity.WARNING, 
                "CAPsMAN AP Disconnected", 
                `CAPsMAN AP ${cap.identity} is disconnected`
              );
            }
          }
        } else {
          // Create new CAPsMAN AP
          const newCapsmanAP: InsertCapsmanAP = {
            deviceId,
            name: cap.identity,
            macAddress: cap["mac-address"],
            identity: cap.identity,
            model: cap.board,
            serialNumber: null, // Not available in this data
            version: cap.version,
            radioName: cap["radio-name"],
            radioMac: cap["radio-mac"],
            state: cap.state,
            ipAddress: cap.address,
            clients: Math.floor(Math.random() * 15), // Would be calculated from actual client data
            uptime: cap.uptime
          };
          
          await storage.createCapsmanAP(newCapsmanAP);
          
          // Generate alert for new AP
          await this.createAlert(
            deviceId, 
            alertSeverity.INFO, 
            "New CAPsMAN AP Detected", 
            `New CAPsMAN AP ${cap.identity} has been detected`
          );
        }
      }
    } catch (err) {
      const error = err as Error;
      console.error(`Failed to collect CAPsMAN stats for device ${deviceId}:`, error.message);
    }
  }
  
  public async discoverDevices(subnet: string): Promise<number> {
    // Cải thiện phương thức khám phá thiết bị Mikrotik trên mạng
    console.log(`Scanning subnet ${subnet} for Mikrotik devices...`);
    
    let discoveredCount = 0;
    
    // Parse subnet (e.g. "192.168.1.0/24")
    const [baseIP, mask] = subnet.split('/');
    const maskBits = parseInt(mask);
    
    if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) {
      throw new Error(`Invalid subnet mask: ${mask}`);
    }
    
    // Calculate IP range to scan
    const baseIPParts = baseIP.split('.').map(part => parseInt(part));
    const ipCount = 2 ** (32 - maskBits);
    const maxHosts = Math.min(ipCount - 2, 254); // Giới hạn thực tế cho việc quét
    
    console.log(`Scanning ${maxHosts} hosts on subnet ${subnet}...`);
    
    // Scan từng IP trong dải mạng
    // Sử dụng batching để tránh quá tải
    const batchSize = 10;
    const totalBatches = Math.ceil(maxHosts / batchSize);
    
    for (let batch = 0; batch < totalBatches; batch++) {
      const startIndex = batch * batchSize + 1;
      const endIndex = Math.min(startIndex + batchSize - 1, maxHosts);
      console.log(`Scanning batch ${batch + 1}/${totalBatches}: IPs ${startIndex} to ${endIndex}`);
      
      const batchPromises = [];
      
      for (let i = startIndex; i <= endIndex; i++) {
        const ip = `${baseIPParts[0]}.${baseIPParts[1]}.${baseIPParts[2]}.${i}`;
        batchPromises.push(this.checkIfMikrotik(ip));
      }
      
      // Đợi tất cả các quét trong batch hoàn thành
      const batchResults = await Promise.all(batchPromises);
      const batchDiscoveredDevices = batchResults.filter(Boolean);
      
      // Thêm các thiết bị được phát hiện vào storage
      for (const device of batchDiscoveredDevices) {
        try {
          // Kiểm tra xem thiết bị đã tồn tại trong storage chưa
          const existingDevice = await storage.getDeviceByIp(device.ipAddress);
          
          if (existingDevice) {
            // Cập nhật thiết bị hiện có với thông tin đăng nhập mới phát hiện
            await storage.updateDevice(existingDevice.id, {
              name: device.name,
              model: device.model,
              serialNumber: device.serialNumber,
              routerOsVersion: device.routerOsVersion,
              firmware: device.firmware,
              cpu: device.cpu,
              totalMemory: device.totalMemory?.toString() || null,
              lastSeen: new Date(),
              // Chỉ cập nhật thông tin đăng nhập nếu thông tin hiện tại không hoạt động
              ...(!existingDevice.isOnline ? {username: device.username, password: device.password} : {})
            });
            
            console.log(`✅ Updated existing device: ${device.name} at ${device.ipAddress}`);
            discoveredCount++;
          } else {
            // Tạo thiết bị mới với thông tin đăng nhập đã phát hiện
            const newDevice: InsertDevice = {
              name: device.name,
              ipAddress: device.ipAddress,
              username: device.username || 'admin',
              password: device.password || '',
              isOnline: false,
              lastSeen: new Date(),
              model: device.model,
              serialNumber: device.serialNumber,
              routerOsVersion: device.routerOsVersion,
              firmware: device.firmware,
              cpu: device.cpu,
              totalMemory: device.totalMemory?.toString() || null
            };
            
            await storage.createDevice(newDevice);
            console.log(`✅ Added new device: ${device.name} at ${device.ipAddress}`);
            discoveredCount++;
          }
        } catch (error) {
          console.error(`Error saving device at ${device.ipAddress}:`, error);
        }
      }
    }
    
    console.log(`Discovery complete. Found ${discoveredCount} MikroTik devices on subnet ${subnet}.`);
    return discoveredCount;
  }
  
  // This method would be implemented to check if a device at a specific IP
  // is a MikroTik device and return its basic information
  private async checkIfMikrotik(ipAddress: string): Promise<any> {
    console.log(`Checking if ${ipAddress} is a MikroTik device...`);
    
    // Danh sách các cổng để thử
    const ports = [8728, 8729, 80, 443];
    // Danh sách tên người dùng thông thường
    const usernames = ["admin", "user", "mikrotik"];
    // Danh sách mật khẩu thông thường (bao gồm mật khẩu trống)
    const passwords = ["", "admin", "mikrotik", "password", "routeros"];
    
    // Thử từng cổng
    for (const port of ports) {
      // Thử từng tổ hợp tên người dùng/mật khẩu
      for (const username of usernames) {
        for (const password of passwords) {
          try {
            console.log(`Trying ${ipAddress}:${port} with ${username}/${password ? '******' : 'blank password'}`);
            
            const client = new MikrotikClient(ipAddress, username, password);
            client.setPort(port);
            
            // Thiết lập thời gian chờ ngắn để quá trình quét nhanh hơn
            const connected = await client.connect(3000);
            
            if (connected) {
              console.log(`✅ Connected to ${ipAddress}:${port} with ${username}/${password ? '******' : 'blank password'}`);
              
              // Thiết bị đã được xác thực - lấy thông tin
              try {
                const resources = await client.executeCommand("/system/resource/print");
                let identity = null;
                try {
                  identity = await client.executeCommand("/system/identity/print");
                } catch (identityError) {
                  console.log(`Could not get identity: ${identityError.message}`);
                }
                
                // Ngắt kết nối
                await client.disconnect();
                
                const deviceName = identity && identity.length > 0 && identity[0].name 
                  ? identity[0].name 
                  : `MikroTik ${resources["board-name"] || 'Router'}`;
                
                // Trả về thông tin thiết bị với thông tin đăng nhập đã được xác minh
                return {
                  ipAddress,
                  name: deviceName,
                  username,
                  password,
                  model: resources["board-name"],
                  serialNumber: resources["serial-number"] || null,
                  routerOsVersion: resources.version,
                  firmware: resources["factory-software"],
                  cpu: resources["cpu-model"],
                  totalMemory: resources["total-memory"],
                  isDiscovered: true,
                  port: port
                };
              } catch (cmdError) {
                console.log(`Connected but failed to get device info: ${cmdError instanceof Error ? cmdError.message : 'Unknown error'}`);
                await client.disconnect();
              }
            }
          } catch (error) {
            // Bỏ qua lỗi - tiếp tục với tổ hợp tiếp theo
          }
        }
      }
    }
    
    return null;
  }
}

export const mikrotikService = new MikrotikService();