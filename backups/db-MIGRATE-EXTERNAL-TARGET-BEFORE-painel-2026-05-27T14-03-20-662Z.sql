-- backup painel 2026-05-27T14:03:20.961Z
SET FOREIGN_KEY_CHECKS=0;

DROP TABLE IF EXISTS `apps`;
CREATE TABLE `apps` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `port` int(11) NOT NULL,
  `type` varchar(50) DEFAULT NULL,
  `data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`data`)),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

DROP TABLE IF EXISTS `cloudflared_instances`;
CREATE TABLE `cloudflared_instances` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `token` varchar(1000) DEFAULT NULL,
  `data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`data`)),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

DROP TABLE IF EXISTS `hosting`;
CREATE TABLE `hosting` (
  `id` varchar(255) NOT NULL,
  `domain` varchar(255) NOT NULL,
  `port` int(11) NOT NULL,
  `root_dir` varchar(255) DEFAULT NULL,
  `php_version` varchar(50) DEFAULT NULL,
  `data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`data`)),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
INSERT INTO `hosting` (`id`, `domain`, `port`, `root_dir`, `php_version`, `data`) VALUES ('1779696096483', '0.0.0.0', 0, '', '', '{"id":"1779696096483","name":"Aprova Concurso","slug":"aprova-concurso","domain":"0.0.0.0","type":"node","listenPort":4000,"targetPort":3001,"path":"/data/data/com.termux/files/home/www/aprova-concurso","startCmd":"node server.js","autoRestart":true,"pid":6193,"status":"offline","publicUrl":"http://127.0.0.1:4000","bindHost":"0.0.0.0","localHost":"localhost","nginxConf":"hosting-aprova-concurso-1779696096483.conf","logFile":"logs/hosting-aprova-concurso-1779696096483.log","errorLog":"logs/hosting-aprova-concurso-1779696096483-error.log","cloudflareTunnel":{"action":"new","hostname":"aprovaconcursos.arjtechbr.site","instanceId":"inst-1779696100231","tunnelName":"aprova-concurso"},"createdAt":"2026-05-25T08:01:44.569Z","updatedAt":"2026-05-27T13:32:59.660Z"}');

DROP TABLE IF EXISTS `settings`;
CREATE TABLE `settings` (
  `key` varchar(255) NOT NULL,
  `value` text DEFAULT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
INSERT INTO `settings` (`key`, `value`) VALUES ('noip_config', '{
  "username": "gcarvalho.slv@gmail.com",
  "password": "W@rface22",
  "hostname": "neurixcurso.ddns.net",
  "interval": 14,
  "ipType": "ipv6",
  "autostart": true
}');

DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
INSERT INTO `users` (`id`, `username`, `password`) VALUES (1, 'admin', 'W@rface21');

SET FOREIGN_KEY_CHECKS=1;
