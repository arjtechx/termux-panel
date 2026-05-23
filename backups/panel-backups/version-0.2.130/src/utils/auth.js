function checkAuth(req, res, next) {
    if (
        req.path === '/login' || 
        req.path === '/login.html' || 
        req.path.startsWith('/api/login') || 
        req.path.startsWith('/socket.io/') || 
        req.path.endsWith('.css') || 
        req.path.endsWith('.js') ||
        req.path === '/api/phpmyadmin/validate-token' ||
        req.path === '/api/pma/sso/validate' ||
        req.path === '/api/database/verify-token' ||
        req.path === '/api/phpmyadmin/validate'
    ) {
        return next();
    }
    if (req.session && req.session.authenticated) {
        return next();
    }
    if (req.path.startsWith('/api')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.redirect('/login.html');
}

module.exports = { checkAuth };
