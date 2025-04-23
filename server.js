const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

// 创建 Express 应用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 提供静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 存储活动连接
const sshConnections = new Map();

// WebSocket 连接处理
wss.on('connection', (ws) => {
  console.log('WebSocket 客户端已连接');

  let sshClient = null;
  let keepAliveInterval = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.type) {
        case 'connect':
          // 处理 SSH 连接请求
          connectSSH(ws, msg.data);
          break;

        case 'data':
          // 将终端输入发送到 SSH 连接
          if (sshClient && sshClient.stream) {
            sshClient.stream.write(msg.data);
          }
          break;

        case 'resize':
          // 调整终端大小
          if (sshClient && sshClient.stream) {
            sshClient.stream.setWindow(msg.data.rows, msg.data.cols);
          }
          break;

        default:
          console.warn('未知消息类型:', msg.type);
      }
    } catch (err) {
      console.error('处理消息时出错:', err);
      sendError(ws, '无效消息格式');
    }
  });

  ws.on('close', () => {
    console.log('WebSocket 客户端已断开连接');
    // 清理资源
    if (sshClient) {
      try {
        if (sshClient.stream) {
          sshClient.stream.end();
        }
        sshClient.end();
      } catch (err) {
        console.error('关闭 SSH 连接时出错:', err);
      }
    }
    
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }
  });

  // 连接到 SSH 服务器
  function connectSSH(ws, options) {
    try {
      const { host, port, username, authMethod, authData, termType, keepAlive, timeout } = options;
      
      // 创建新的 SSH 客户端
      sshClient = new Client();
      
      // 连接超时处理
      const connectTimeout = setTimeout(() => {
        if (sshClient) {
          sshClient.end();
          sendError(ws, '连接超时');
        }
      }, (timeout || 10) * 1000);
      
      // 配置 SSH 连接
      const connectConfig = {
        host,
        port: port || 22,
        username,
        readyTimeout: (timeout || 10) * 1000
      };
      
      // 添加认证信息
      if (authMethod === 'password') {
        connectConfig.password = authData.password;
      } else {
        connectConfig.privateKey = authData.privateKey;
        if (authData.passphrase) {
          connectConfig.passphrase = authData.passphrase;
        }
      }

      // 连接到SSH服务器
      sshClient.on('ready', () => {
        console.log(`已连接到 SSH 服务器: ${host}:${port}`);
        clearTimeout(connectTimeout);

        // 打开 shell
        sshClient.shell({
          term: termType || 'xterm-256color',
          cols: 80,
          rows: 24
        }, (err, stream) => {
          if (err) {
            console.error('打开 shell 时出错:', err);
            sshClient.end();
            sendError(ws, '打开 shell 时出错: ' + err.message);
            return;
          }

          // 保存 stream 到客户端
          sshClient.stream = stream;

          // 通知前端已连接
          ws.send(JSON.stringify({
            type: 'connected'
          }));

          // 处理来自 SSH 的数据
          stream.on('data', (data) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'data',
                data: data.toString('utf-8')
              }));
            }
          });

          // 处理 SSH 流关闭
          stream.on('close', () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'data',
                data: '\r\n*** SSH 会话已关闭 ***\r\n'
              }));
            }
            sshClient.end();
          });

          // 处理 SSH 流错误
          stream.on('error', (err) => {
            console.error('SSH 流错误:', err);
            sendError(ws, 'SSH 流错误: ' + err.message);
          });
        });

        // 设置保持活动连接
        if (keepAlive > 0) {
          keepAliveInterval = setInterval(() => {
            sshClient.ping((err) => {
              if (err) {
                console.error('保持活动连接错误:', err);
                clearInterval(keepAliveInterval);
                if (sshClient) {
                  sshClient.end();
                }
                sendError(ws, '连接已断开');
              }
            });
          }, keepAlive * 1000);
        }
      });

      sshClient.on('error', (err) => {
        console.error('SSH 连接错误:', err);
        clearTimeout(connectTimeout);
        sendError(ws, '连接错误: ' + err.message);
      });

      sshClient.on('end', () => {
        console.log('SSH 连接已结束');
        if (keepAliveInterval) {
          clearInterval(keepAliveInterval);
        }
      });

      // 连接到 SSH 服务器
      sshClient.connect(connectConfig);
    } catch (err) {
      console.error('创建 SSH 连接时出错:', err);
      sendError(ws, '创建连接时出错: ' + err.message);
    }
  }

  // 发送错误消息到客户端
  function sendError(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message
      }));
    }
  }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器已启动，端口: ${PORT}`);
});
