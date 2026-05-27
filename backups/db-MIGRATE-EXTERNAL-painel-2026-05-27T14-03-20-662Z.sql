-- backup painel 2026-05-27T14:03:20.950Z
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

DROP TABLE IF EXISTS `settings`;
CREATE TABLE `settings` (
  `key` varchar(255) NOT NULL,
  `value` text DEFAULT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
INSERT INTO `settings` (`key`, `value`) VALUES ('noip_config', '{
  "username": "arjtechx@gmail.com",
  "password": "mapamundi",
  "hostname": "neurixcurso.ddns.net",
  "interval": 15,
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
INSERT INTO `users` (`id`, `username`, `password`) VALUES (1, 'admin', 'admin');

SET FOREIGN_KEY_CHECKS=1;
